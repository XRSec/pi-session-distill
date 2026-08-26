// @ts-nocheck
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import {atomicReplace0600} from "./core.ts";

type ModelRef = {provider: string; id: string};
type DistillConfig = {defaultLlmModel?: ModelRef};

export function distillConfigPath(): string {
    return process.env.SESSION_DISTILL_CONFIG_PATH || path.join(os.homedir(), ".pi", "agent", "pi-session-distill.json");
}

export function readDistillConfig(): DistillConfig {
    const configPath = distillConfigPath();
    if (!fs.existsSync(configPath)) return {};
    const text = fs.readFileSync(configPath, "utf8").trim();
    if (!text) return {};

    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`配置文件必须是 JSON 对象: ${configPath}`);
    }
    const model = parsed.defaultLlmModel;
    if (model === undefined) return {};
    if (!model || typeof model !== "object" || typeof model.provider !== "string" || typeof model.id !== "string" || !model.provider || !model.id) {
        throw new Error(`defaultLlmModel 必须包含非空 provider 和 id: ${configPath}`);
    }
    return {defaultLlmModel: {provider: model.provider, id: model.id}};
}

export async function initializeDistillSettings(ctx: any): Promise<void> {
    if (readDistillConfig().defaultLlmModel || !ctx.hasUI) return;
    await configureDistillModel(ctx);
}

export async function configureDistillModel(ctx: any): Promise<void> {
    if (!ctx.hasUI) throw new Error("/cleanup model 需要交互式 UI");

    const models = ctx.modelRegistry.getAvailable()
        .slice()
        .sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
    if (models.length === 0) {
        ctx.ui.notify("没有可用于 session-distill 的 Pi 模型；清洗时将使用当前会话模型", "warning");
        return;
    }

    const labels = models.map((model) => {
        const key = `${model.provider}/${model.id}`;
        return model.name && model.name !== model.id ? `${key} — ${model.name}` : key;
    });
    const selected = await ctx.ui.select("Default LLM Model", labels);
    if (!selected) return;

    const model = models[labels.indexOf(selected)];
    if (!model) return;
    atomicReplace0600(distillConfigPath(), `${JSON.stringify({
        defaultLlmModel: {provider: model.provider, id: model.id},
    }, null, 2)}\n`);
    ctx.ui.notify(`session-distill 默认模型已设为 ${model.provider}/${model.id}`, "info");
}

export function resolveDistillModel(ctx: any): unknown {
    const configured = readDistillConfig().defaultLlmModel;
    if (configured && typeof ctx.modelRegistry?.find === "function" && typeof ctx.modelRegistry?.getAvailable === "function") {
        const model = ctx.modelRegistry.find(configured.provider, configured.id);
        const available = ctx.modelRegistry.getAvailable().some((candidate) =>
            candidate.provider === configured.provider && candidate.id === configured.id,
        );
        if (model && available) return model;
    }
    return ctx.model;
}
