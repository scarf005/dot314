import { describe, expect, test } from "bun:test";

import {
    appendCwdProbe,
    createCwdProbeMarker,
    extractCwdProbe,
    isAutoCwdEnabled,
    parseSimpleCdTarget,
} from "../../../extensions/_shared/auto-cwd-detection";
import {
    getMainWorktreeRootFromWorktreeList,
    isMainWorktreeTarget,
    MAIN_WORKTREE_TOKEN,
    normalizeTargetCwd,
} from "../../../extensions/_shared/normalize-target-cwd";

describe("normalizeTargetCwd", () => {
    test("resolves relative target paths to absolute paths", () => {
        expect(normalizeTargetCwd("../foo", {}, "/tmp/work/project")).toBe("/tmp/work/foo");
    });

    test("expands ~ before resolving the target path", () => {
        expect(normalizeTargetCwd("~/code", { HOME: "/Users/tester" }, "/tmp/work/project")).toBe(
            "/Users/tester/code",
        );
    });

    test("identifies the main worktree token", () => {
        expect(isMainWorktreeTarget(MAIN_WORKTREE_TOKEN)).toBe(true);
        expect(isMainWorktreeTarget("$root")).toBe(false);
    });

    test("reads the main worktree root from the first worktree list entry", () => {
        const worktreeListOutput = [
            "worktree /Users/tester/project",
            "HEAD 1234567890abcdef",
            "branch refs/heads/main",
            "",
            "worktree /Users/tester/project-feature",
            "HEAD abcdef1234567890",
            "branch refs/heads/feature",
            "",
        ].join("\n");

        expect(getMainWorktreeRootFromWorktreeList(worktreeListOutput)).toBe("/Users/tester/project");
    });

    test("rejects bare repositories without a main worktree", () => {
        expect(() => getMainWorktreeRootFromWorktreeList("worktree /Users/tester/project.git\nbare\n")).toThrow(
            "Cannot determine main git worktree",
        );
    });
});

describe("auto cwd detection", () => {
    test("reads opt-in state from environment-like values", () => {
        expect(isAutoCwdEnabled({ PI_MOVE_SESSION_AUTO_CWD: "1" })).toBe(true);
        expect(isAutoCwdEnabled({ PI_MOVE_SESSION_AUTO_CWD: "on" })).toBe(true);
        expect(isAutoCwdEnabled({ PI_MOVE_SESSION_AUTO_CWD: "0" })).toBe(false);
    });

    test("appends a cwd probe without hiding the original command exit status", () => {
        const marker = createCwdProbeMarker("tool-call/1");
        expect(appendCwdProbe("false", marker)).toContain("__pi_move_session_status=$?");
        expect(appendCwdProbe("false", marker)).toContain("exit $__pi_move_session_status");
    });

    test("extracts and removes cwd probe output", () => {
        const marker = createCwdProbeMarker("abc");
        const result = extractCwdProbe(`hello\n${marker}/tmp/project\nworld`, marker);
        expect(result.cwd).toBe("/tmp/project");
        expect(result.text).toBe("hello\nworld");
    });

    test("parses simple user cd commands", () => {
        expect(parseSimpleCdTarget("cd ../next", {}, "/tmp/project")).toBe("/tmp/next");
        expect(parseSimpleCdTarget("cd '/tmp/with spaces'", {}, "/tmp/project")).toBe("/tmp/with spaces");
        expect(parseSimpleCdTarget("cd", { HOME: "/home/tester" }, "/tmp/project")).toBe("/home/tester");
        expect(parseSimpleCdTarget("cd /tmp && pwd", {}, "/tmp/project")).toBeUndefined();
    });
});
