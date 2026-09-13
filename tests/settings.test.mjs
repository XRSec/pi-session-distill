import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {generateNativeCompaction, removeNativeCompactionCheckpoint} from "../native-compaction.ts";
import {configureDistillModel, distillConfigPath, initializeDistillSettings, resolveDistillModel} from "../settings.ts";
const {default: installExtension} = await import("../index.ts");

function withConfigPath(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-distill-settings-"));
    const configPath = path.join(directory, "pi-session-distill.json");
    const previous = process.env.SESSION_DISTILL_CONFIG_PATH;
    process.env.SESSION_DISTILL_CONFIG_PATH = configPath;
    t.after(() => {
        if (previous === undefined) delete process.env.SESSION_DISTILL_CONFIG_PATH;
        else process.env.SESSION_DISTILL_CONFIG_PATH = previous;
        fs.rmSync(directory, {recursive: true, force: true});
    });
    return configPath;
}

const currentModel = {provider: "current", id: "session-model"};
const preferredModel = {provider: "openai", id: "preferred", name: "Preferred"};

test("RPC 首次启动不等待选择框；可直接设置包含斜杠的模型 ID", async (t) => {
    const configPath = withConfigPath(t);
    const ctx = {
        mode: "rpc", hasUI: true,
        modelRegistry: {getAvailable: () => [{provider: "proxy", id: "vendor/model"}]},
        ui: {select() { assert.fail("RPC startup must not block on UI"); }, notify() {}},
    };
    await initializeDistillSettings(ctx);
    assert.equal(fs.existsSync(configPath), false);
    await configureDistillModel(ctx, "proxy/vendor/model");
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath)), {defaultLlmModel: {provider: "proxy", id: "vendor/model"}});
    await assert.rejects(configureDistillModel(ctx, "unknown/model"), /默认模型不可用/);
    assert.equal(JSON.parse(fs.readFileSync(configPath)).defaultLlmModel.id, "vendor/model");
});

test("配置遵循 PI_CODING_AGENT_DIR，显式 distill 路径仍优先", (t) => {
    const configured = withConfigPath(t);
    const previous = process.env.PI_CODING_AGENT_DIR;
    t.after(() => {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
    });
    process.env.PI_CODING_AGENT_DIR = path.dirname(configured);
    assert.equal(distillConfigPath(), configured);
    delete process.env.SESSION_DISTILL_CONFIG_PATH;
    assert.equal(distillConfigPath(), path.join(path.dirname(configured), "pi-session-distill.json"));
});

test("首次使用从 Pi 可用模型中选择并写入 0600 配置", async (t) => {
    const configPath = withConfigPath(t);
    let title;
    const notices = [];
    await initializeDistillSettings({
        hasUI: true,
        modelRegistry: {getAvailable: () => [preferredModel, currentModel]},
        ui: {
            async select(value, options) {
                title = value;
                return options.find((option) => option.startsWith("openai/preferred"));
            },
            notify(message, level) {
                notices.push({message, level});
            },
        },
    });

    assert.equal(title, "Default LLM Model");
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), {
        defaultLlmModel: {provider: "openai", id: "preferred"},
    });
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
    assert.equal(notices.at(-1).level, "info");
});

test("/cleanup model 可主动覆盖已有默认模型", async (t) => {
    const configPath = withConfigPath(t);
    fs.writeFileSync(configPath, JSON.stringify({defaultLlmModel: {provider: "current", id: "session-model"}}));

    let cleanup;
    installExtension({
        on() {},
        registerCommand(name, command) {
            if (name === "cleanup") cleanup = command;
        },
    });
    assert.ok(cleanup);
    await cleanup.handler("model", {
        hasUI: true,
        modelRegistry: {getAvailable: () => [preferredModel, currentModel]},
        ui: {
            async select(_title, options) {
                return options.find((option) => option.startsWith("openai/preferred"));
            },
            notify() {},
        },
    });

    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), {
        defaultLlmModel: {provider: "openai", id: "preferred"},
    });
});

test("配置模型不可用时回退当前会话模型", (t) => {
    const configPath = withConfigPath(t);
    fs.writeFileSync(configPath, JSON.stringify({defaultLlmModel: {provider: "openai", id: "preferred"}}));

    const unavailable = resolveDistillModel({
        model: currentModel,
        modelRegistry: {
            find: () => preferredModel,
            getAvailable: () => [currentModel],
        },
    });
    assert.equal(unavailable, currentModel);

    const available = resolveDistillModel({
        model: currentModel,
        modelRegistry: {
            find: () => preferredModel,
            getAvailable: () => [preferredModel, currentModel],
        },
    });
    assert.equal(available, preferredModel);
});

test("native compaction 优先调用配置模型", async (t) => {
    const configPath = withConfigPath(t);
    const checkpointRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-distill-settings-checkpoint-"));
    const previousCheckpointRoot = process.env.SESSION_DISTILL_CHECKPOINT_ROOT;
    process.env.SESSION_DISTILL_CHECKPOINT_ROOT = checkpointRoot;
    t.after(() => {
        if (previousCheckpointRoot === undefined) delete process.env.SESSION_DISTILL_CHECKPOINT_ROOT;
        else process.env.SESSION_DISTILL_CHECKPOINT_ROOT = previousCheckpointRoot;
        fs.rmSync(checkpointRoot, {recursive: true, force: true});
    });
    fs.writeFileSync(configPath, JSON.stringify({defaultLlmModel: {provider: "openai", id: "preferred"}}));
    let calledModel;
    const ctx = {
        model: currentModel,
        modelRegistry: {
            find: () => preferredModel,
            getAvailable: () => [preferredModel, currentModel],
            async complete(model) {
                calledModel = model;
                return {content: [{type: "text", text: "checkpoint"}]};
            },
        },
    };

    const generated = await generateNativeCompaction({
        preparation: {
            messagesToSummarize: [],
            turnPrefixMessages: [],
            firstKeptEntryId: "kept",
            tokensBefore: 1,
            fileOps: {read: new Set(), written: new Set(), edited: new Set()},
        },
        signal: new AbortController().signal,
    }, ctx);

    assert.equal(calledModel, preferredModel);
    removeNativeCompactionCheckpoint(generated.checkpointKey);
});
