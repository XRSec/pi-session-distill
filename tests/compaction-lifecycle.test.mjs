import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {SessionManager} from "@earendil-works/pi-coding-agent";
import {hiddenHistoryArchiveFromSessionLines, hiddenHistorySourceBytes} from "../history.ts";
import {generateNativeCompaction, removeNativeCompactionCheckpoint} from "../native-compaction.ts";

const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-distill-backup-test-"));
const checkpointRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-distill-native-checkpoint-test-"));
process.env.SESSION_DISTILL_BACKUP_ROOT = backupRoot;
process.env.SESSION_DISTILL_CHECKPOINT_ROOT = checkpointRoot;
process.on("exit", () => {
    fs.rmSync(backupRoot, {recursive: true, force: true});
    fs.rmSync(checkpointRoot, {recursive: true, force: true});
});
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

function registeredLifecycleHandlers() {
    const handlers = new Map();
    installExtension({
        registerCommand() {},
        on(name, handler) {
            handlers.set(name, handler);
        },
    });
    return handlers;
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
    assert.equal(reopened.getEntries().filter((entry) => entry.type === "message").length, 3);
    assert.match(contextEntries[0].details.branchLabel, /^PSD M \d{2}\/\d{2} \d{2}:\d{2}$/);
    assert.equal(contextEntries[0].details.compactionTrigger, "manual");
    assert.match(contextEntries[0].details.compactionTimestamp, /^\d{4}-\d{2}-\d{2}T/);
    const mergeRoot = reopened.getEntries().find((entry) => entry.type === "custom" && entry.customType === "cleanup_merge_root");
    const sourceRoot = reopened.getEntries().find((entry) => entry.type === "custom_message" && entry.customType === "cleanup_source_root");
    const marker = reopened.getEntries().find((entry) => entry.type === "message" && entry.parentId === mergeRoot?.id);
    assert.ok(mergeRoot);
    assert.ok(marker);
    assert.equal(sourceRoot?.parentId, mergeRoot.id);
    assert.equal(sourceRoot?.display, false);
    assert.equal(contextEntries[0].parentId, marker.id);
    assert.equal(reopened.getBranch().some((entry) => entry.id === sourceRoot.id), false);
    assert.deepEqual(reopened.buildSessionContext().messages.map((message) => message.role), ["compactionSummary"]);
    assert.deepEqual(archivedSourceBytes(sessionFile, manager.getSessionId()), originalBytes);
});

test("/cleanup this --print 对短会话也会重建隐藏历史分支", async (t) => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-distill-short-"));
    t.after(() => fs.rmSync(sessionDir, {recursive: true, force: true}));
    const cwd = path.join(sessionDir, "project");
    fs.mkdirSync(cwd);
    const manager = SessionManager.create(cwd, sessionDir);
    manager.appendMessage({role: "user", content: [{type: "text", text: "short input"}], timestamp: 1});
    manager.appendMessage({role: "assistant", content: [{type: "text", text: "short result"}], timestamp: 2});
    const sessionFile = manager.getSessionFile();
    const originalBytes = fs.readFileSync(sessionFile);
    const ctx = {
        cwd,
        mode: "print",
        waitForIdle: async () => {},
        sessionManager: {getSessionFile: () => sessionFile},
        model: {provider: "test", id: "model"},
        modelRegistry: {
            async complete() {
                return {content: [{type: "text", text: "short-checkpoint"}], usage: {input: 1, output: 1, totalTokens: 2}};
            },
        },
        ui: {notify() {}},
        compact() {
            assert.fail("print 模式不应经过 Pi 的 compaction 阈值门");
        },
    };

    await registeredCleanup().handler("this", ctx);
    manager.appendCustomEntry("stale_runtime_state", {saved: true});

    const reopened = SessionManager.open(sessionFile);
    assert.equal(reopened.getBranch().at(-1)?.customType, "stale_runtime_state");
    assert.match(reopened.buildContextEntries()[0].details.branchLabel, /^PSD M \d{2}\/\d{2} \d{2}:\d{2}$/);
    const mergeRoot = reopened.getEntries().find((entry) => entry.type === "custom" && entry.customType === "cleanup_merge_root");
    const sourceRoot = reopened.getEntries().find((entry) => entry.type === "custom_message" && entry.customType === "cleanup_source_root");
    assert.ok(mergeRoot);
    assert.equal(sourceRoot?.parentId, mergeRoot.id);
    assert.equal(sourceRoot?.display, false);
    assert.equal(reopened.getEntries().some((entry) => entry.customType === "cleanup_full_span_boundary"), false);
    assert.deepEqual(reopened.buildSessionContext().messages.map((message) => message.role), ["compactionSummary"]);
    assert.deepEqual(archivedSourceBytes(sessionFile, manager.getSessionId()), originalBytes);
});

test("/cleanup this 在 Pi Web RPC 模式刷新分支，并在刷新被拒绝时回滚", async (t) => {
    const runCase = async (refreshFails) => {
        const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-distill-rpc-"));
        t.after(() => fs.rmSync(sessionDir, {recursive: true, force: true}));
        const cwd = path.join(sessionDir, "project");
        fs.mkdirSync(cwd);
        const manager = SessionManager.create(cwd, sessionDir);
        manager.appendMessage({role: "user", content: [{type: "text", text: "rpc input"}], timestamp: 1});
        manager.appendMessage({role: "assistant", content: [{type: "text", text: "rpc result"}], timestamp: 2});
        const sessionFile = manager.getSessionFile();
        const originalBytes = fs.readFileSync(sessionFile);
        let navigations = 0;
        const ctx = {
            cwd,
            mode: "rpc",
            waitForIdle: async () => {},
            sessionManager: manager,
            model: {provider: "test", id: "model"},
            modelRegistry: {
                async complete() {
                    return {content: [{type: "text", text: "rpc-checkpoint"}], usage: {input: 1, output: 1, totalTokens: 2}};
                },
            },
            ui: {notify() {}},
            async navigateTree(targetId) {
                navigations++;
                if (refreshFails) return {cancelled: true};
                manager.branch(targetId);
                return {cancelled: false};
            },
            async reload() {
                assert.fail("RPC 模式不应依赖宿主 reload 实现");
            },
            async switchSession() {
                assert.fail("RPC 模式不应调用 switchSession");
            },
        };

        if (refreshFails) {
            await assert.rejects(registeredCleanup().handler("this", ctx), /源会话已恢复: Pi Web 拒绝刷新/);
            assert.deepEqual(fs.readFileSync(sessionFile), originalBytes);
        } else {
            await registeredCleanup().handler("this", ctx);
            const reopened = SessionManager.open(sessionFile);
            assert.equal(reopened.buildContextEntries()[0].summary, "rpc-checkpoint");
            assert.deepEqual(reopened.buildSessionContext().messages.map((message) => message.role), ["compactionSummary"]);
        }
        assert.equal(navigations, 1);
    };

    await runCase(false);
    await runCase(true);
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
    assert.equal(reopened.getEntries().filter((entry) => entry.type === "message").length, 3);
    assert.match(contextEntries[0].details.branchLabel, /^PSD M \d{2}\/\d{2} \d{2}:\d{2}$/);
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

test("/cleanup this 在源文件仅追加非上下文元数据后复用原生 LLM 结果", async (t) => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-distill-native-reuse-"));
    t.after(() => fs.rmSync(sessionDir, {recursive: true, force: true}));
    const cwd = path.join(sessionDir, "project");
    fs.mkdirSync(cwd);
    const manager = SessionManager.create(cwd, sessionDir);
    manager.appendMessage({role: "user", content: [{type: "text", text: "stable input"}], timestamp: 1});
    manager.appendMessage({role: "assistant", content: [{type: "text", text: "stable result"}], timestamp: 2});
    const sessionFile = manager.getSessionFile();
    let modelCalls = 0;
    const ctx = {
        cwd,
        mode: "print",
        waitForIdle: async () => {},
        sessionManager: {getSessionFile: () => sessionFile},
        model: {provider: "test", id: "metadata-reuse-model"},
        modelRegistry: {
            async complete() {
                modelCalls++;
                if (modelCalls === 1) {
                    fs.appendFileSync(sessionFile, `${JSON.stringify({
                        type: "session_info",
                        id: "metadata-title",
                        parentId: manager.getLeafId(),
                        timestamp: new Date().toISOString(),
                        name: "Generated title",
                    })}\n`);
                }
                return {content: [{type: "text", text: "cached-checkpoint"}], usage: {input: 1, output: 1, totalTokens: 2}};
            },
        },
        ui: {notify() {}},
    };

    await assert.rejects(registeredCleanup().handler("this", ctx), /写入前发生变化/);
    await registeredCleanup().handler("this", ctx);

    assert.equal(modelCalls, 1);
    assert.equal(SessionManager.open(sessionFile).buildContextEntries()[0].summary, "cached-checkpoint");
});

test("native compaction 请求使用独立 routing session ID、禁用 prompt-cache 写入并复用相同请求", async () => {
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

    const first = await generateNativeCompaction(event, ctx);
    const second = await generateNativeCompaction(event, ctx);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].cacheRetention, "none");
    assert.equal(calls[0].signal, signal);
    assert.match(calls[0].sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(second.compaction.summary, first.compaction.summary);

    removeNativeCompactionCheckpoint(second.checkpointKey);
    const third = await generateNativeCompaction(event, ctx);
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].sessionId, calls[1].sessionId);

    const changed = await generateNativeCompaction({
        ...event,
        preparation: {
            ...event.preparation,
            messagesToSummarize: [{role: "user", content: [{type: "text", text: "different input"}]}],
        },
    }, ctx);
    assert.equal(calls.length, 3);
    const custom = await generateNativeCompaction({...event, customInstructions: "focus on verification"}, ctx);
    assert.equal(calls.length, 4);
    removeNativeCompactionCheckpoint(third.checkpointKey);
    removeNativeCompactionCheckpoint(changed.checkpointKey);
    removeNativeCompactionCheckpoint(custom.checkpointKey);
});

test("native compaction 空响应保留模型错误并写入诊断日志", async () => {
    const events = [];
    const ctx = {
        model: {provider: "test", id: "empty-response-model"},
        modelRegistry: {
            async complete() {
                return {
                    content: [],
                    stopReason: "error",
                    errorMessage: "request body too large",
                };
            },
        },
    };
    const event = {
        preparation: {
            messagesToSummarize: [{role: "user", content: [{type: "text", text: "unique empty response input"}]}],
            turnPrefixMessages: [],
            firstKeptEntryId: "kept",
            tokensBefore: 100,
            fileOps: {read: new Set(), written: new Set(), edited: new Set()},
        },
        signal: new AbortController().signal,
    };

    try {
        await assert.rejects(
            generateNativeCompaction(event, ctx, {logger: {write: (name, data) => events.push({name, data})}}),
            /native compaction 模型未生成 checkpoint: request body too large/,
        );
        const responseEvent = events.find(({name}) => name === "native_compaction_model_response");
        assert.deepEqual(responseEvent?.data, {
            checkpointKey: events.find(({name}) => name === "native_compaction_checkpoint_ready").data.checkpointKey,
            inputHash: events.find(({name}) => name === "native_compaction_checkpoint_ready").data.inputHash,
            stopReason: "error",
            outputChars: 0,
            errorMessage: "request body too large",
        });
    } finally {
        removeNativeCompactionCheckpoint(events.find(({name}) => name === "native_compaction_checkpoint_ready")?.data.checkpointKey);
    }
});

test("默认压缩失败时复用结果，session_compact 成功后删除 checkpoint", async () => {
    const handlers = registeredLifecycleHandlers();
    const beforeCompact = handlers.get("session_before_compact");
    const compacted = handlers.get("session_compact");
    assert.ok(beforeCompact);
    assert.ok(compacted);
    let modelCalls = 0;
    const ctx = {
        model: {provider: "test", id: "default-hook-cache-model"},
        modelRegistry: {
            async complete() {
                modelCalls++;
                return {
                    content: [{type: "text", text: "hook-checkpoint"}],
                    usage: {input: 1, output: 1, totalTokens: 2},
                };
            },
        },
        ui: {notify() {}},
    };
    const event = {
        preparation: {
            messagesToSummarize: [],
            turnPrefixMessages: [],
            firstKeptEntryId: "hook-kept",
            tokensBefore: 200,
            fileOps: {read: new Set(), written: new Set(), edited: new Set()},
        },
        signal: new AbortController().signal,
    };

    const first = await beforeCompact(event, ctx);
    const retry = await beforeCompact(event, ctx);
    assert.equal(modelCalls, 1);
    assert.equal(retry.compaction.summary, first.compaction.summary);

    await compacted({compactionEntry: retry.compaction}, ctx);
    await beforeCompact(event, ctx);
    assert.equal(modelCalls, 2);
    await compacted({compactionEntry: retry.compaction}, ctx);
});

test("当当前活动会话尚未在磁盘落盘时，多会话和指定会话 cleanup 不会因 realpathSync 抛出 ENOENT", async (t) => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-distill-noent-test-"));
    t.after(() => fs.rmSync(sessionDir, {recursive: true, force: true}));
    const cwd = path.join(sessionDir, "project");
    fs.mkdirSync(cwd);

    // 创建两个已持久化的历史会话
    const s1 = SessionManager.create(cwd, sessionDir);
    s1.appendMessage({role: "user", content: [{type: "text", text: "session 1 user"}], timestamp: 1});
    s1.appendMessage({role: "assistant", content: [{type: "text", text: "session 1 assistant"}], timestamp: 2});
    const s1Id = s1.getSessionId();

    const s2 = SessionManager.create(cwd, sessionDir);
    s2.appendMessage({role: "user", content: [{type: "text", text: "session 2 user"}], timestamp: 3});
    s2.appendMessage({role: "assistant", content: [{type: "text", text: "session 2 assistant"}], timestamp: 4});
    const s2Id = s2.getSessionId();

    const cleanup = registeredCleanup();
    const nonExistentActiveFile = path.join(sessionDir, "2026-09-02T10-26-41-625Z_01a061a8-1959-7796-b9b8-e403b506f2b7.jsonl");
    assert.equal(fs.existsSync(nonExistentActiveFile), false);

    const mockCtx = {
        cwd,
        hasUI: false,
        mode: "print",
        model: {provider: "test", id: "mock-model"},
        modelRegistry: {
            async complete() {
                return {
                    content: [{type: "text", text: "checkpoint summary"}],
                    usage: {input: 10, output: 10, totalTokens: 20},
                };
            },
        },
        sessionManager: {
            getSessionId: () => "01a061a8-1959-7796-b9b8-e403b506f2b7",
            getSessionFile: () => nonExistentActiveFile,
            getCwd: () => cwd,
            getHeader: () => null,
            getSessionName: () => undefined,
        },
        ui: {
            notify() {},
        },
        waitForIdle: async () => {},
    };

    const origListAll = SessionManager.listAll;
    SessionManager.listAll = async () => [
        {path: s1.getSessionFile(), id: s1Id, cwd, name: "s1", created: new Date()},
        {path: s2.getSessionFile(), id: s2Id, cwd, name: "s2", created: new Date()},
    ];
    t.after(() => {
        SessionManager.listAll = origListAll;
    });

    // 验证多会话 textual cleanup 不会因 active session 尚未在磁盘落盘而抛出 ENOENT
    await assert.doesNotReject(async () => {
        await cleanup.handler(`--textual ${s1Id} ${s2Id}`, mockCtx);
    });

    // 验证指定会话 native compaction 不会因 active session 尚未在磁盘落盘而抛出 ENOENT
    await assert.doesNotReject(async () => {
        await cleanup.handler(s1Id, mockCtx);
    });
});

