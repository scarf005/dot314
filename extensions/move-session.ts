/**
 * Session Move Extension
 *
 * Move the current session into another cwd bucket and relaunch pi in that directory.
 * Optionally auto-detect bash/user-bash cwd changes and move at the end of the turn.
 *
 * Implementation strategy:
 *  1) Fork the current session file into the target cwd bucket using SessionManager.forkFrom()
 *  2) Clear the fork header's parentSession pointer
 *  3) Stop the parent's TUI through the public custom UI API
 *  4) Spawn a new pi process in the target cwd with inherited stdio
 *  5) Once the child has spawned, trash the old session file
 *  6) Once the child has spawned, destroy the parent's stdin so it cannot steal key presses
 *  7) Parent stays alive as an inert wrapper, forwarding the child's exit code
 *
 * Usage:
 *   /move-session <targetCwd>
 *   /move-session-auto on|off|status
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType, SessionManager } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import {
    statSync,
    openSync,
    readSync,
    writeSync,
    closeSync,
    renameSync,
    unlinkSync,
} from "node:fs";
import { resolve } from "node:path";

import {
    appendCwdProbe,
    createCwdProbeMarker,
    extractCwdProbe,
    isAutoCwdEnabled,
    parseSimpleCdTarget,
} from "./_shared/auto-cwd-detection";
import {
    getMainWorktreeRootFromWorktreeList,
    isMainWorktreeTarget,
    MAIN_WORKTREE_TOKEN,
    normalizeTargetCwd,
} from "./_shared/normalize-target-cwd";
import { getPiSpawnCommand } from "./_shared/pi-spawn";

const TRASH_TIMEOUT_MS = 5000;
const HEADER_READ_MAX = 8192;
const COPY_CHUNK_SIZE = 65_536;

type MoveSessionContext = Pick<ExtensionContext,
    "cwd" | "mode" | "hasUI" | "sessionManager" | "ui" | "isIdle" | "hasPendingMessages"
>;

interface PendingCwdProbe {
    marker: string;
    sourceCwd: string;
}

function getBranchSelectionWarning(
    sourceSessionFile: string,
    currentLeafId: string | null,
    commandName: string,
    actionName: string,
): string | null {
    try {
        const persistedSession = SessionManager.open(sourceSessionFile);
        const hasPersistedEntries = persistedSession.getEntries().length > 0;
        if (!hasPersistedEntries) {
            return null;
        }

        const persistedLeafId = persistedSession.getLeafId() as string | null;
        if (currentLeafId === null) {
            return `${commandName} will not preserve the current /tree root selection. It reopens at the session file's default branch tip. Consider /fork first or continue from the branch tip before ${actionName}.`;
        }

        if (currentLeafId !== persistedLeafId) {
            return `${commandName} will not preserve the current /tree selection. It reopens at the session file's default branch tip. Consider /fork first or continue from the branch tip before ${actionName}.`;
        }
    } catch {
        // Ignore warning-detection failures
    }

    return null;
}

/**
 * Remove parentSession from the first JSONL header line without loading
 * the entire file into memory
 */
function clearParentSession(sessionFile: string): void {
    const fd = openSync(sessionFile, "r");
    const headerBuffer = Buffer.alloc(HEADER_READ_MAX);
    const bytesRead = readSync(fd, headerBuffer, 0, HEADER_READ_MAX, 0);
    const headerChunk = headerBuffer.toString("utf-8", 0, bytesRead);
    const newlineIndex = headerChunk.indexOf("\n");

    if (newlineIndex === -1) {
        closeSync(fd);
        return;
    }

    const header = JSON.parse(headerChunk.slice(0, newlineIndex));
    if (!header.parentSession) {
        closeSync(fd);
        return;
    }

    delete header.parentSession;
    const newHeaderLine = JSON.stringify(header) + "\n";
    const originalHeaderBytes = Buffer.byteLength(headerChunk.slice(0, newlineIndex + 1), "utf-8");

    const temporaryPath = sessionFile + ".move-session-tmp";
    let writeFd: number | undefined;
    try {
        writeFd = openSync(temporaryPath, "w");
        const newHeaderBuffer = Buffer.from(newHeaderLine, "utf-8");
        writeSync(writeFd, newHeaderBuffer, 0, newHeaderBuffer.length);

        const copyBuffer = Buffer.alloc(COPY_CHUNK_SIZE);
        let position = originalHeaderBytes;
        for (;;) {
            const readCount = readSync(fd, copyBuffer, 0, COPY_CHUNK_SIZE, position);
            if (readCount === 0) break;
            writeSync(writeFd, copyBuffer, 0, readCount);
            position += readCount;
        }

        closeSync(writeFd);
        writeFd = undefined;
        closeSync(fd);
        renameSync(temporaryPath, sessionFile);
    } catch (error) {
        if (writeFd !== undefined) {
            try {
                closeSync(writeFd);
            } catch {
                // ignore cleanup close errors
            }
        }

        closeSync(fd);
        try {
            unlinkSync(temporaryPath);
        } catch {
            // ignore cleanup unlink errors
        }
        throw error;
    }
}

function isSameCwd(left: string, right: string): boolean {
    return resolve(left) === resolve(right);
}

function replaceTextContent<T extends { type: string; text?: string }>(
    content: T[],
    marker: string,
): { content: T[]; cwd?: string } {
    let detectedCwd: string | undefined;
    const nextContent = content.map((block) => {
        if (block.type !== "text" || typeof block.text !== "string") {
            return block;
        }

        const result = extractCwdProbe(block.text, marker);
        if (result.cwd !== undefined) {
            detectedCwd = result.cwd;
        }

        return { ...block, text: result.text || "(no output)" };
    });

    return { content: nextContent, cwd: detectedCwd };
}

export default function (pi: ExtensionAPI) {
    let autoCwdEnabled = isAutoCwdEnabled();
    let pendingAutoMoveTarget: string | undefined;
    let moveInProgress = false;
    let autoMoveTimer: ReturnType<typeof setTimeout> | undefined;
    const pendingCwdProbes = new Map<string, PendingCwdProbe>();

    const resolveTargetCwd = async (rawTargetCwd: string, cwd: string): Promise<string> => {
        if (!isMainWorktreeTarget(rawTargetCwd)) {
            return normalizeTargetCwd(rawTargetCwd, process.env, cwd);
        }

        const result = await pi.exec("git", ["worktree", "list", "--porcelain"], { cwd, timeout: 5000 });
        if (result.code !== 0) {
            const stderr = result.stderr.trim();
            throw new Error(stderr || `git worktree list --porcelain failed with code ${result.code}`);
        }

        return getMainWorktreeRootFromWorktreeList(result.stdout);
    };

    const trashFileBestEffort = async (filePath: string) => {
        try {
            const { code } = await pi.exec("trash", [filePath], { timeout: TRASH_TIMEOUT_MS });
            if (code === 0) {
                return;
            }
        } catch {
            // ignore
        }

        // If "trash" isn't available, do not fall back to unlink.
        // This extension should never permanently delete session files.
    };

    const moveCurrentSession = async (
        rawTargetCwd: string,
        ctx: MoveSessionContext,
        options: { commandName: string; actionName: string; deferIfBusy?: boolean; auto?: boolean },
    ) => {
        if (moveInProgress) return;
        // Older supported Pi contexts expose hasUI, but not mode.
        if (ctx.mode === undefined ? !ctx.hasUI : ctx.mode !== "tui") {
            ctx.ui.notify("Moving a session requires interactive TUI mode.", "error");
            return;
        }
        moveInProgress = true;

        let targetCwd: string;
        try {
            targetCwd = await resolveTargetCwd(rawTargetCwd, ctx.cwd);
        } catch (error: any) {
            moveInProgress = false;
            ctx.ui.notify(error?.message ?? String(error), "error");
            return;
        }

        // Resolution can await git. Do not fork while new work is running or queued.
        if (!ctx.isIdle() || ctx.hasPendingMessages()) {
            moveInProgress = false;
            if (options.deferIfBusy) {
                pendingAutoMoveTarget ??= targetCwd;
                scheduleAutoMove(ctx, 100);
            } else {
                ctx.ui.notify("Session is busy or has queued messages; try /move-session again when idle.", "warning");
            }
            return;
        }

        let targetCwdStat;
        try {
            targetCwdStat = statSync(targetCwd);
        } catch (error: any) {
            moveInProgress = false;
            const code = error?.code;
            if (code === "ENOENT") {
                // An automatic move waits for idle, so the detected directory can be
                // gone by now (a scratch directory removed in the same turn). Drop it.
                if (!options.auto) {
                    ctx.ui.notify(`Path does not exist: ${targetCwd}`, "error");
                }
            } else {
                ctx.ui.notify(`Cannot access path: ${targetCwd}`, "error");
            }
            return;
        }

        if (!targetCwdStat.isDirectory()) {
            moveInProgress = false;
            ctx.ui.notify(`Not a directory: ${targetCwd}`, "error");
            return;
        }

        const sourceSessionFile = ctx.sessionManager.getSessionFile();
        if (!sourceSessionFile) {
            moveInProgress = false;
            ctx.ui.notify("No persistent session file (maybe started with --no-session)", "error");
            return;
        }

        const branchSelectionWarning = getBranchSelectionWarning(
            sourceSessionFile,
            ctx.sessionManager.getLeafId() as string | null,
            options.commandName,
            options.actionName,
        );
        if (branchSelectionWarning) {
            ctx.ui.notify(branchSelectionWarning, "warning");
        }

        try {
            const forked = SessionManager.forkFrom(sourceSessionFile, targetCwd);
            const destSessionFile = forked.getSessionFile();

            if (!destSessionFile) {
                moveInProgress = false;
                ctx.ui.notify("Internal error: forkFrom() produced no session file", "error");
                return;
            }

            // We intend to move/replace the original session, so avoid leaving
            // a parentSession pointer that may dangle after trashing the source.
            try {
                clearParentSession(destSessionFile);
            } catch (error: any) {
                ctx.ui.notify(
                    `Warning: could not clear parent session reference: ${error?.message ?? String(error)}`,
                    "warning",
                );
            }

            // The public interactive-shell example uses custom() + tui.stop() to
            // release the terminal. Unlike disabling stdin, stop() also cancels
            // renders and removes resize listeners before the child can write.
            await ctx.ui.custom<void>((tui, _theme, _keybindings, _done) => {
                const piCommand = getPiSpawnCommand(["--session", destSessionFile]);
                tui.stop();

                let child;
                try {
                    child = spawn(piCommand.command, piCommand.args, {
                        cwd: targetCwd,
                        stdio: "inherit",
                    });
                } catch (error) {
                    // A synchronous spawn failure leaves the parent usable.
                    tui.start();
                    throw error;
                }

                child.once("spawn", () => {
                    // Trash the old session file *after* the new process is actually running
                    void trashFileBestEffort(sourceSessionFile);

                    // Stop the parent from stealing keypresses.
                    // destroy() is important; pause() was not sufficient.
                    process.stdin.removeAllListeners();
                    process.stdin.destroy();

                    // Avoid the parent reacting to Ctrl+C / termination signals.
                    // (The child is the process the user is interacting with.)
                    process.removeAllListeners("SIGINT");
                    process.removeAllListeners("SIGTERM");
                    process.on("SIGINT", () => {});
                    process.on("SIGTERM", () => {});
                });

                child.on("exit", (code) => process.exit(code ?? 0));
                child.on("error", (err) => {
                    process.stderr.write(`Failed to launch pi: ${err.message}\n`);
                    process.exit(1);
                });

                // Do not complete custom() or restart the parent while the child
                // owns the terminal. The wrapper exits with the child, as before.
                return { render: () => [], invalidate: () => {} };
            });
        } catch (error: any) {
            moveInProgress = false;
            ctx.ui.notify(`Failed to move session: ${error?.message ?? String(error)}`, "error");
        }
    };

    const queueAutoMove = (targetCwd: string, sourceCwd: string, ctx: MoveSessionContext) => {
        if (!autoCwdEnabled || moveInProgress || isSameCwd(targetCwd, sourceCwd)) {
            return;
        }

        pendingAutoMoveTarget = targetCwd;
        ctx.ui.notify(`Detected cwd change to ${targetCwd}; moving Pi session when idle.`, "info");
    };

    pi.registerCommand("move-session", {
        description: "Move session to another directory and relaunch pi there",
        getArgumentCompletions: (argumentPrefix: string) => {
            const trimmedPrefix = argumentPrefix.trimStart();
            if (!MAIN_WORKTREE_TOKEN.startsWith(trimmedPrefix)) {
                return null;
            }

            return [{
                value: MAIN_WORKTREE_TOKEN,
                label: MAIN_WORKTREE_TOKEN,
                description: "Move session to this repository's main git worktree",
            }];
        },
        handler: async (args, ctx) => {
            await ctx.waitForIdle();

            const rawTargetCwd = args.trim();
            if (!rawTargetCwd) {
                ctx.ui.notify("Usage: /move-session <targetCwd>", "error");
                return;
            }

            await moveCurrentSession(rawTargetCwd, ctx, {
                commandName: "/move-session",
                actionName: "moving",
            });
        },
    });

    pi.registerCommand("move-session-auto", {
        description: "Enable, disable, or show automatic cwd-change session moves",
        getArgumentCompletions: (argumentPrefix: string) => {
            const prefix = argumentPrefix.trim().toLowerCase();
            return ["on", "off", "status"]
                .filter((value) => value.startsWith(prefix))
                .map((value) => ({ value, label: value }));
        },
        handler: async (args, ctx) => {
            const mode = args.trim().toLowerCase() || "status";
            if (mode === "on") {
                autoCwdEnabled = true;
                ctx.ui.notify("Automatic cwd-change session moves enabled.", "info");
                return;
            }

            if (mode === "off") {
                autoCwdEnabled = false;
                pendingAutoMoveTarget = undefined;
                clearTimeout(autoMoveTimer);
                autoMoveTimer = undefined;
                pendingCwdProbes.clear();
                ctx.ui.notify("Automatic cwd-change session moves disabled.", "info");
                return;
            }

            if (mode === "status") {
                ctx.ui.notify(
                    `Automatic cwd-change session moves are ${autoCwdEnabled ? "enabled" : "disabled"}.`,
                    "info",
                );
                return;
            }

            ctx.ui.notify("Usage: /move-session-auto on|off|status", "error");
        },
    });

    pi.on("tool_call", (event, ctx) => {
        if (!autoCwdEnabled || moveInProgress || !isToolCallEventType("bash", event)) {
            return;
        }

        if (typeof event.input.command !== "string") return;

        const marker = createCwdProbeMarker(event.toolCallId);
        pendingCwdProbes.set(event.toolCallId, { marker, sourceCwd: ctx.cwd });
        event.input.command = appendCwdProbe(event.input.command, marker);
    });

    pi.on("tool_result", (event, ctx) => {
        if (event.toolName !== "bash") return;

        const pendingProbe = pendingCwdProbes.get(event.toolCallId);
        if (!pendingProbe) return;

        pendingCwdProbes.delete(event.toolCallId);
        const result = replaceTextContent(event.content, pendingProbe.marker);
        if (result.cwd) {
            queueAutoMove(result.cwd, pendingProbe.sourceCwd, ctx);
        }

        return { content: result.content };
    });

    const scheduleAutoMove = (ctx: MoveSessionContext, delayMs = 0) => {
        if (autoMoveTimer || !pendingAutoMoveTarget || !autoCwdEnabled || moveInProgress) return;
        // Leave event dispatch first. agent_end can precede retries/compaction;
        // keep checking idle even when manual compaction ends without a new run.
        autoMoveTimer = setTimeout(() => {
            autoMoveTimer = undefined;
            const targetCwd = pendingAutoMoveTarget;
            if (!targetCwd || !autoCwdEnabled || moveInProgress) return;
            if (!ctx.isIdle() || ctx.hasPendingMessages()) {
                scheduleAutoMove(ctx, 100);
                return;
            }

            pendingAutoMoveTarget = undefined;
            void moveCurrentSession(targetCwd, ctx, {
                commandName: "auto cwd detection",
                actionName: "auto-moving",
                deferIfBusy: true,
                auto: true,
            });
        }, delayMs);
        autoMoveTimer.unref();
    };

    pi.on("agent_end", (_event, ctx) => scheduleAutoMove(ctx));
    pi.on("agent_settled", (_event, ctx) => scheduleAutoMove(ctx));

    const clearPendingAutoMove = () => {
        clearTimeout(autoMoveTimer);
        autoMoveTimer = undefined;
        pendingAutoMoveTarget = undefined;
        pendingCwdProbes.clear();
    };
    pi.on("session_start", clearPendingAutoMove);
    pi.on("session_shutdown", clearPendingAutoMove);

    pi.on("user_bash", (event, ctx) => {
        if (!autoCwdEnabled || moveInProgress) return;

        let targetCwd: string | undefined;
        try {
            targetCwd = parseSimpleCdTarget(event.command, process.env, event.cwd);
        } catch (error: any) {
            return { result: { output: error?.message ?? String(error), exitCode: 1, cancelled: false, truncated: false } };
        }

        if (!targetCwd || isSameCwd(targetCwd, event.cwd)) return;

        pendingAutoMoveTarget = targetCwd;
        scheduleAutoMove(ctx);

        return {
            result: {
                output: `Detected cwd change to ${targetCwd}; moving Pi session there.`,
                exitCode: 0,
                cancelled: false,
                truncated: false,
            },
        };
    });
}
