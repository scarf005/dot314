import { resolve } from "node:path";

export const AUTO_CWD_ENV = "PI_MOVE_SESSION_AUTO_CWD";
export const CWD_PROBE_PREFIX = "__PI_MOVE_SESSION_CWD";

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unquoteShellWord(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length < 2) return trimmed;

    const quote = trimmed[0];
    if ((quote !== "'" && quote !== '"') || trimmed[trimmed.length - 1] !== quote) {
        return trimmed;
    }

    const inner = trimmed.slice(1, -1);
    if (quote === "'") return inner;

    return inner.replace(/\\(["\\$`])/g, "$1");
}

export function isAutoCwdEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const value = env[AUTO_CWD_ENV]?.trim().toLowerCase();
    return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function createCwdProbeMarker(toolCallId: string): string {
    const safeId = toolCallId.replace(/[^A-Za-z0-9_]/g, "_");
    return `${CWD_PROBE_PREFIX}_${safeId}__=`;
}

export function appendCwdProbe(command: string, marker: string): string {
    return [
        command,
        "__pi_move_session_status=$?",
        `printf '\\n${marker}%s\\n' "$PWD"`,
        "exit $__pi_move_session_status",
    ].join("\n");
}

export function extractCwdProbe(text: string, marker: string): { text: string; cwd?: string } {
    const pattern = new RegExp(`(^|\\r?\\n)${escapeRegExp(marker)}([^\\r\\n]*)(?=\\r?\\n|$)`);
    const match = pattern.exec(text);
    if (!match) return { text };

    const cwd = match[2];
    const start = match.index;
    const end = match.index + match[0].length;
    const separator = match[1];
    const prefix = text.slice(0, start);
    const suffix = text.slice(end).replace(/^\r?\n/, "");
    const textWithoutProbe = separator && prefix && suffix ? prefix + separator + suffix : prefix + suffix;

    return { text: textWithoutProbe, cwd };
}

export function parseSimpleCdTarget(
    command: string,
    env: NodeJS.ProcessEnv = process.env,
    cwd: string = process.cwd(),
): string | undefined {
    const trimmed = command.trim();
    const match = /^(?:builtin\s+)?cd(?:\s+--)?(?:\s+(.+?))?\s*$/.exec(trimmed);
    if (!match) return undefined;

    const rawTarget = match[1]?.trim();
    if (!rawTarget || rawTarget === "~") {
        const home = env.HOME || env.USERPROFILE;
        if (!home) throw new Error("Cannot resolve cd target: $HOME is not set");
        return resolve(home);
    }

    if (rawTarget === "-") return undefined;

    const quote = rawTarget[0];
    const fullyQuoted = (quote === "'" || quote === '"') && rawTarget[rawTarget.length - 1] === quote;
    if (!fullyQuoted && /[;&|<>]/.test(rawTarget)) return undefined;

    return resolve(cwd, unquoteShellWord(rawTarget));
}
