import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {SessionManager} from "@earendil-works/pi-coding-agent";
import {hiddenHistoryArchiveFromSessionLines, hiddenHistorySourceBytes} from "../history.ts";
import {generateNativeCompaction} from "../native-compaction.ts";

const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-distill-backup-test-"));
process.env.SESSION_DISTILL_BACKUP_ROOT = backupRoot;
process.on("exit", () => fs.rmSync(backupRoot, {recursive: true, force: true}));
const {default: installExtension} = await import("../index.ts");

function archivedSourceBytes(file, sourceId) {
    const manager = SessionManager.open(file);
    return hiddenHistorySourceBytes(hiddenHistoryArchiveFromSessionLines([manager.getHeader(), ...manager.getBranch()]), sourceId);
}

function registeredCleanup() {
    let cleanup;
    installExtension({
        registerCommand(name, command) {
            if (name === "cleanup") cleanup = command;
        },
        on() {},
    });
    assert.ok(cleanup);
    return cleanup;
}

test("/cleanup this 从会话文件重建完整上下文并刷新为单一可见 checkpoint", async (t) => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-distill-test-"));
    t.after(() => fs.rmSync(sessionDir, {recursive: true, force: true}));
    const cwd = path.join(sessionDir, "project");
    fs.mkdirSync(cwd);
    const manager = SessionManager.create(cwd, sessionDir);
    manager.appendMessage({
        role: "user",
        content: [{type: "text", text: "WHOLE-SESSION-START"}],
        timestamp: 1,
    });
    manager.appendMessage({
        role: "assistant",
        content: [{type: "text", text: "WHOLE-SESSION-END"}],
        timestamp: 2,
    });
    const sessionFile = manager.getSessionFile();
    const originalBytes = fs.readFileSync(sessionFile);
    const originalRecordCount = originalBytes.toString("utf8").trim().split("\n").length;

    let prompt = "";
    const switchPaths = [];
    const notifications = [];
    const switchSession = async (sessionPath, options) => {
        switchPaths.push(sessionPath);
        const freshManager = SessionManager.open(sessionPath);
        await options.withSession({
            ui: {
                notify(message, level) {
                    notifications.push({message, level});
                },
            },
            sessionManager: freshManager,
            switchSession,
        });
        return {cancelled: false};
    };
    const ctx = {
        cwd,
        mode: "tui",
        waitForIdle: async () => {},
        sessionManager: {
            getSessionFile: () => manager.getSessionFile(),
            getBranch: () => [],
            buildSessionContext: () => ({messages: []}),
        },
        model: {provider: "test", id: "model"},
        modelRegistry: {
            async complete(_model, context) {
                prompt = context.messages[0].content[0].text;
                return {
                    content: [{type: "text", text: "checkpoint"}],
                    usage: {input: 1, output: 1, totalTokens: 2},
                };
            },
        },
        ui: {notify() {}},
        switchSession,
    };

    await registeredCleanup().handler("this", ctx);

    assert.match(prompt, /WHOLE-SESSION-START/);
    assert.match(prompt, /WHOLE-SESSION-END/);
    assert.match(prompt, /Full-span cleanup: every effective message is included above/);
    assert.equal(switchPaths.length, 2);
    assert.match(switchPaths[0], /session-distill-refresh-/);
    assert.equal(switchPaths[1], sessionFile);
    assert.equal(notifications.at(-1).level, "info");
    assert.match(notifications.at(-1).message, new RegExp(`${originalRecordCount} 条 hidden archive 记录`));

    const reopened = SessionManager.open(sessionFile);
    const contextEntries = reopened.buildContextEntries();
    assert.equal(contextEntries[0].type, "compaction");
    assert.equal(contextEntries[0].summary, "checkpoint");
    assert.ok(contextEntries.slice(1).every((entry) => entry.type === "custom" || entry.type === "session_info"));
    assert.equal(reopened.getSessionName(), "WHOLE-SESSION-START");
    assert.equal(reopened.getEntries().filter((entry) => entry.type === "message").length, 2);
    assert.equal(reopened.getEntries().some((entry) => entry.type === "custom_message" && entry.customType === "cleanup_source_root"), true);
    assert.deepEqual(reopened.buildSessionContext().messages.map((message) => message.role), ["compactionSummary"]);
    assert.deepEqual(archivedSourceBytes(sessionFile, manager.getSessionId()), originalBytes);
});

test("/cleanup this 返回原会话被取消时留在安全 staging 且不误报写入失败", async (t) => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-distill-cancel-"));
    t.after(() => fs.rmSync(sessionDir, {recursive: true, force: true}));
    const cwd = path.join(sessionDir, "project");
    fs.mkdirSync(cwd);
    const manager = SessionManager.create(cwd, sessionDir);
    manager.appendMessage({role: "user", content: [{type: "text", text: "cancel-safe"}], timestamp: 1});
    manager.appendMessage({role: "assistant", content: [{type: "text", text: "cancel-safe-result"}], timestamp: 2});
    const sessionFile = manager.getSessionFile();
    const warnings = [];
    let stagingPath = "";
    const ctx = {
        cwd,
        mode: "tui",
        waitForIdle: async () => {},
        sessionManager: {getSessionFile: () => sessionFile},
        model: {provider: "test", id: "model"},
        modelRegistry: {
            async complete() {
                return {content: [{type: "text", text: "safe-checkpoint"}], usage: {input: 1, output: 1, totalTokens: 2}};
            },
        },
        ui: {notify() {}},
        async switchSession(pathname, options) {
            stagingPath = pathname;
            await options.withSession({
                ui: {notify(message, level) { warnings.push({message, level}); }},
                sessionManager: SessionManager.open(pathname),
                async switchSession() { return {cancelled: true}; },
            });
            return {cancelled: false};
        },
    };
    t.after(() => stagingPath && fs.rmSync(stagingPath, {force: true}));

    await registeredCleanup().handler("this", ctx);

    assert.match(stagingPath, /session-distill-refresh-/);
    assert.equal(fs.existsSync(stagingPath), true);
    assert.equal(warnings.at(-1).level, "warning");
    assert.match(warnings.at(-1).message, /checkpoint 已写入/);
    const reopened = SessionManager.open(sessionFile);
    assert.equal(reopened.buildContextEntries()[0].summary, "safe-checkpoint");
    assert.deepEqual(reopened.buildSessionContext().messages.map((message) => message.role), ["compactionSummary"]);
});

test("/cleanup this 可再次提炼以 thinking_level_change 结尾的既有 checkpoint", async (t) => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-distill-repeat-"));
    t.after(() => fs.rmSync(sessionDir, {recursive: true, force: true}));
    const cwd = path.join(sessionDir, "project");
    fs.mkdirSync(cwd);
    const manager = SessionManager.create(cwd, sessionDir);
    manager.appendMessage({role: "user", content: [{type: "text", text: "old input"}], timestamp: 1});
    manager.appendMessage({role: "assistant", content: [{type: "text", text: "old result"}], timestamp: 2});
    const boundaryId = manager.appendCustomMessageEntry("old_boundary", [], false);
    manager.appendCompaction("OLD-CHECKPOINT", boundaryId, 100, {
        readFiles: ["read.ts"],
        modifiedFiles: ["written.ts"],
    }, true);
    manager.appendThinkingLevelChange("high");
    const sessionFile = manager.getSessionFile();
    const originalBytes = fs.readFileSync(sessionFile);

    const packageEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
    const native = await import(new URL("./core/compaction/compaction.js", packageEntry));
    assert.equal(native.prepareCompaction(manager.getBranch(), {
        enabled: true,
        reserveTokens: 16384,
        keepRecentTokens: 0,
    }), undefined);

    let prompt = "";
    const ctx = {
        cwd,
        mode: "print",
        waitForIdle: async () => {},
        sessionManager: {getSessionFile: () => manager.getSessionFile()},
        model: {provider: "test", id: "model"},
        modelRegistry: {
            async complete(_model, context) {
                prompt = context.messages[0].content[0].text;
                return {
                    content: [{type: "text", text: "NEW-CHECKPOINT"}],
                    usage: {input: 1, output: 1, totalTokens: 2},
                };
            },
        },
        ui: {notify() {}},
        async switchSession() {
            throw new Error("print mode 不应切换 session");
        },
    };

    await registeredCleanup().handler("this", ctx);

    assert.match(prompt, /OLD-CHECKPOINT/);
    const reopened = SessionManager.open(sessionFile);
    const contextEntries = reopened.buildContextEntries();
    assert.equal(contextEntries[0].type, "compaction");
    assert.equal(contextEntries[0].summary, "NEW-CHECKPOINT");
    assert.ok(contextEntries.slice(1).every((entry) => entry.type === "custom" || entry.type === "session_info"));
    assert.equal(reopened.getSessionName(), "old input");
    assert.equal(reopened.getEntries().filter((entry) => entry.type === "message").length, 2);
    assert.equal(reopened.getEntries().some((entry) => entry.type === "custom_message" && entry.customType === "cleanup_source_root"), true);
    assert.deepEqual(reopened.buildSessionContext().messages.map((message) => message.role), ["compactionSummary"]);
    assert.deepEqual(contextEntries[0].details.readFiles, ["read.ts"]);
    assert.deepEqual(contextEntries[0].details.modifiedFiles, ["written.ts"]);
    assert.deepEqual(archivedSourceBytes(sessionFile, manager.getSessionId()), originalBytes);

    const firstCleanupBytes = fs.readFileSync(sessionFile);
    await registeredCleanup().handler("this", ctx);
    const repeated = SessionManager.open(sessionFile);
    assert.equal(repeated.buildContextEntries()[0].summary, "NEW-CHECKPOINT");
    assert.deepEqual(repeated.buildSessionContext().messages.map((message) => message.role), ["compactionSummary"]);
    assert.deepEqual(archivedSourceBytes(sessionFile, manager.getSessionId()), firstCleanupBytes);
});

test("native compaction 请求使用独立 routing session ID 且禁用 prompt-cache 写入", async () => {
    const calls = [];
    const signal = new AbortController().signal;
    const ctx = {
        model: {provider: "test", id: "model"},
        modelRegistry: {
            async complete(_model, _context, options) {
                calls.push(options);
                return {
                    content: [{type: "text", text: "checkpoint"}],
                    usage: {input: 1, output: 1, totalTokens: 2},
                };
            },
        },
    };
    const event = {
        preparation: {
            messagesToSummarize: [],
            turnPrefixMessages: [],
            firstKeptEntryId: "kept",
            tokensBefore: 100,
            fileOps: {read: new Set(), written: new Set(), edited: new Set()},
        },
        signal,
    };

    await generateNativeCompaction(event, ctx);
    await generateNativeCompaction(event, ctx);

    assert.equal(calls[0].cacheRetention, "none");
    assert.equal(calls[0].signal, signal);
    assert.match(calls[0].sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.notEqual(calls[0].sessionId, calls[1].sessionId);
});
