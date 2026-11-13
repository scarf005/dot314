import assert from "node:assert/strict";
import { spawn as nativeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

// Run with node --experimental-vm-modules --test extensions/move-session.test.mjs.
// PI_TEST_PACKAGE_ROOT may point to an installed Pi when peers are not installed locally.
const require = createRequire(import.meta.url);
const root = process.env.PI_TEST_PACKAGE_ROOT ?? dirname(require.resolve("@earendil-works/pi-coding-agent/package.json"));
const { TuiMainScreen } = await import(join(root, "node_modules/@earendil-works/pi-tui/dist/tui-main-screen.js"));
const wait = () => new Promise((resolve) => setTimeout(resolve, 120));

async function fixture({ realSpawnFailure = false } = {}) {
    const directory = mkdtempSync(join(tmpdir(), "move-session-test-"));
    const source = join(directory, "source.jsonl");
    writeFileSync(source, '{"type":"session","id":"fixture"}\n');
    const output = [];
    const dimensions = { columns: 80, rows: 24 };
    class Terminal {
        get columns() { return dimensions.columns; }
        get rows() { return dimensions.rows; }
        start(input, resize) { this.input = input; this.resize = resize; }
        stop() { this.input = undefined; this.resize = undefined; }
        write(text) { output.push(text); }
        hideCursor() {}
        showCursor() {}
    }
    const terminal = new Terminal();
    const tui = new TuiMainScreen(terminal);
    tui.addChild({ render: () => ["OLD_PARENT_CHECKPOINT"], invalidate() {} });
    tui.start();
    await wait();
    const lateResize = terminal.resize;
    const commands = new Map();
    const events = new Map();
    const children = [];
    const trashed = [];
    const notifications = [];
    let idle = true;
    let pending = false;
    let spawnError;
    const fakeProcess = new EventEmitter();
    Object.assign(fakeProcess, {
        env: { PI_MOVE_SESSION_AUTO_CWD: "1" },
        stdout: { write() {} }, stderr: { write() {} },
        stdin: { isTTY: true, setRawMode() {}, removeAllListeners() {}, destroy() { terminal.input = undefined; } },
        exit(code) { fakeProcess.exitCode = code; },
    });
    const context = vm.createContext({ process: fakeProcess, Buffer, setTimeout, clearTimeout });
    const cache = new Map();
    const stubs = {
        "@earendil-works/pi-coding-agent": {
            isToolCallEventType: (name, event) => event.toolName === name,
            SessionManager: {
                open: () => ({ getEntries: () => [], getLeafId: () => null }),
                forkFrom: () => {
                    const dest = join(directory, `fork-${children.length}.jsonl`);
                    writeFileSync(dest, fs.readFileSync(source));
                    return { getSessionFile: () => dest };
                },
            },
        },
        "node:child_process": { spawn: (_command, _args, options) => {
            assert.equal(terminal.resize, undefined, "parent must stop before child launch");
            assert.equal(options.cwd, directory === options.cwd ? directory : join(directory, "target"));
            assert.equal(options.stdio, "inherit");
            assert.equal(_args[0], "--session");
            assert.equal(fs.existsSync(_args[1]), true);
            if (spawnError) throw spawnError;
            const child = realSpawnFailure
                ? nativeSpawn(join(directory, "nonexistent-pi"), [], { cwd: directory, stdio: "ignore" })
                : new EventEmitter();
            children.push(child);
            return child;
        } },
        "./_shared/pi-spawn": { getPiSpawnCommand: (args) => ({ command: "fixture-pi", args }) },
    };
    async function load(specifier, parent = resolve("extensions/move-session.ts")) {
        const stub = stubs[specifier];
        if (stub || specifier.startsWith("node:")) {
            const exports = stub ?? await import(specifier);
            return new vm.SyntheticModule(Object.keys(exports), function () {
                for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
            }, { context });
        }
        const path = specifier.startsWith(".") ? resolve(dirname(parent), specifier + ".ts") : specifier;
        if (cache.has(path)) return cache.get(path);
        const module = new vm.SourceTextModule(stripTypeScriptTypes(fs.readFileSync(path, "utf8")), { context, identifier: path });
        cache.set(path, module);
        await module.link((next) => load(next, path));
        return module;
    }
    const module = await load(resolve("extensions/move-session.ts"));
    await module.evaluate();
    const ctx = {
        cwd: directory, mode: "tui", hasUI: true,
        isIdle: () => idle, hasPendingMessages: () => pending,
        sessionManager: { getSessionFile: () => source, getLeafId: () => null },
        waitForIdle: async () => {},
        ui: {
            notify: (...args) => notifications.push(args),
            custom: (factory) => new Promise((resolve, reject) => {
                try { factory(tui, {}, {}, resolve); } catch (error) { reject(error); }
            }),
        },
    };
    module.namespace.default({
        registerCommand: (name, command) => commands.set(name, command),
        on: (name, handler) => events.set(name, handler),
        exec: async (_command, args) => { trashed.push(...args); return { code: 0 }; },
    });
    return {
        ctx, commands, events, children, output, notifications, trashed, fakeProcess, tui, directory,
        setIdle: (value) => { idle = value; }, setPending: (value) => { pending = value; },
        setSpawnError: (value) => { spawnError = value; },
        async resize() { dimensions.columns--; lateResize(); tui.requestRender(true); await wait(); },
        cleanup() { events.get("session_shutdown")?.(); tui.stop(); rmSync(directory, { recursive: true, force: true }); },
    };
}

test("manual move stops parent before spawn, including late resize and scheduled render", async () => {
    const f = await fixture();
    try {
        void f.commands.get("move-session").handler(f.directory, f.ctx);
        await wait();
        assert.equal(f.children.length, 1);
        f.children[0].emit("spawn");
        f.output.length = 0;
        await f.resize();
        assert.equal(f.output.some((text) => text.includes("OLD_PARENT_CHECKPOINT")), false);
        assert.equal(f.trashed.length, 1);
        f.children[0].emit("exit", 7);
        assert.equal(f.fakeProcess.exitCode, 7);
    } finally { f.cleanup(); }
});

function detectToolCwd(f, target = f.directory + "/target") {
    const event = { toolName: "bash", toolCallId: "cwd-probe", input: { command: "cd target" } };
    f.events.get("tool_call")(event, f.ctx);
    const result = f.events.get("tool_result")({
        toolName: "bash", toolCallId: event.toolCallId,
        content: [{ type: "text", text: `output\n__PI_MOVE_SESSION_CWD_cwd_probe__=${target}\n` }],
    }, f.ctx);
    assert.equal(result.content[0].text, "output");
}

for (const busyKind of ["retry/compaction", "queued work"]) {
    test(`automatic tool move waits for settled and ${busyKind}`, async () => {
        const f = await fixture();
        try {
            const target = join(f.directory, "target");
            fs.mkdirSync(target);
            detectToolCwd(f, target);
            if (busyKind === "queued work") f.setPending(true);
            else f.setIdle(false);
            await f.events.get("agent_end")?.({}, f.ctx);
            await wait();
            assert.equal(f.children.length, 0);
            f.events.get("agent_settled")({}, f.ctx);
            await wait();
            assert.equal(f.children.length, 0);
            f.setIdle(true);
            f.setPending(false);
            // No additional lifecycle event: manual compaction/queue clearing
            // must not leave the remembered target stranded forever.
            await wait();
            assert.equal(f.children.length, 1);
            f.output.length = 0;
            await f.resize();
            assert.equal(f.output.some((text) => text.includes("OLD_PARENT_CHECKPOINT")), false);
        } finally { f.cleanup(); }
    });
}

test("automatic move to a vanished target is cancelled without an error notification", async () => {
    const f = await fixture();
    try {
        const target = join(f.directory, "target");
        fs.mkdirSync(target);
        detectToolCwd(f, target);
        // Same-turn cleanup removes the probe directory before agent_end runs the move.
        fs.rmSync(target, { recursive: true, force: true });
        await f.events.get("agent_end")({}, f.ctx);
        await wait();
        assert.equal(f.children.length, 0);
        assert.deepEqual(f.notifications.filter(([, level]) => level === "error"), []);
        // A later detected cwd still moves after the cancelled one.
        fs.mkdirSync(target);
        detectToolCwd(f, target);
        await f.events.get("agent_end")({}, f.ctx);
        await wait();
        assert.equal(f.children.length, 1);
    } finally { f.cleanup(); }
});

test("user-bash move releases terminal after result and repeated child sessions stay stopped", async () => {
    const parents = [];
    try {
        for (let index = 0; index < 3; index++) {
            const f = await fixture();
            parents.push(f);
            const target = join(f.directory, "target");
            fs.mkdirSync(target);
            const result = f.events.get("user_bash")({ command: `cd ${target}`, cwd: f.directory }, f.ctx);
            assert.equal(result.result.exitCode, 0);
            assert.equal(f.children.length, 0);
            await wait();
            assert.equal(f.children.length, 1);
            f.children[0].emit("spawn");
        }
        for (const f of parents) {
            f.output.length = 0;
            await f.resize();
            assert.deepEqual(f.output, []);
        }
    } finally { for (const f of parents) f.cleanup(); }
});

test("launch error never trashes source and retains the existing exit code", async () => {
    const f = await fixture();
    try {
        void f.commands.get("move-session").handler(f.directory, f.ctx);
        await wait();
        f.children[0].emit("error", new Error("ENOENT"));
        assert.equal(f.fakeProcess.exitCode, 1);
        assert.deepEqual(f.trashed, []);
        f.output.length = 0;
        await f.resize();
        assert.deepEqual(f.output, []);
    } finally { f.cleanup(); }
});

test("synchronous launch failure restores parent TUI and allows another move", async () => {
    const f = await fixture();
    try {
        f.setSpawnError(new Error("invalid spawn arguments"));
        await f.commands.get("move-session").handler(f.directory, f.ctx);
        assert.equal(f.children.length, 0);
        assert.deepEqual(f.trashed, []);
        assert.match(f.notifications.at(-1)[0], /Failed to move session/);
        f.output.length = 0;
        await f.resize();
        assert.equal(f.output.some((text) => text.includes("OLD_PARENT_CHECKPOINT")), true);
        f.setSpawnError(undefined);
        void f.commands.get("move-session").handler(f.directory, f.ctx);
        await wait();
        assert.equal(f.children.length, 1);
    } finally { f.cleanup(); }
});

test("legacy hasUI-only contexts still support manual moves", async () => {
    const f = await fixture();
    try {
        delete f.ctx.mode;
        void f.commands.get("move-session").handler(f.directory, f.ctx);
        await wait();
        assert.equal(f.children.length, 1);
    } finally { f.cleanup(); }
});

test("non-TUI modes never spawn an inherited-terminal child", async () => {
    const f = await fixture();
    try {
        f.ctx.mode = "rpc";
        await f.commands.get("move-session").handler(f.directory, f.ctx);
        assert.equal(f.children.length, 0);
        assert.match(f.notifications.at(-1)[0], /interactive TUI/);
    } finally { f.cleanup(); }
});

test("real ENOENT launch error leaves source intact and parent stopped", async () => {
    const f = await fixture({ realSpawnFailure: true });
    try {
        void f.commands.get("move-session").handler(f.directory, f.ctx);
        await wait();
        assert.equal(f.fakeProcess.exitCode, 1);
        assert.deepEqual(f.trashed, []);
        assert.equal(fs.existsSync(f.ctx.sessionManager.getSessionFile()), true);
        f.output.length = 0;
        await f.resize();
        assert.deepEqual(f.output, []);
    } finally { f.cleanup(); }
});

for (const eventName of ["session_start", "session_shutdown"]) {
    test(`${eventName} cancels a busy automatic move`, async () => {
        const f = await fixture();
        try {
            f.setIdle(false);
            detectToolCwd(f);
            f.events.get("agent_end")({}, f.ctx);
            await wait();
            f.events.get(eventName)({}, f.ctx);
            f.setIdle(true);
            await wait();
            assert.equal(f.children.length, 0);
        } finally { f.cleanup(); }
    });
}

test("disabling automatic moves cancels a scheduled user-bash move", async () => {
    const f = await fixture();
    try {
        f.events.get("user_bash")({ command: `cd ${f.directory}/target`, cwd: f.directory }, f.ctx);
        await f.commands.get("move-session-auto").handler("off", f.ctx);
        await wait();
        assert.equal(f.children.length, 0);
    } finally { f.cleanup(); }
});
