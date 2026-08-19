import * as crypto from "crypto";
import type {SourceRef} from "./core.ts";
import type {CleanupDiagnostics, CleanupPolicy, CleanupResult, StoredCleanIr} from "./textual.ts";
import type {AgentHandoffReport} from "./handoff.ts";
import {storedIrFromResult} from "./textual.ts";

function entryId(): string {
    return crypto.randomBytes(4).toString("hex");
}

export interface TextualCleanupManifest {
    schemaVersion: 3 | 4;
    cleanerVersion: string;
    runId: string;
    createdAt: string;
    mode: "textual" | "capsule" | "handoff";
    directSources: SourceRef[];
    sourceSnapshots?: Array<{sourceId: string; sha256: string; bytes: number}>;
    sourceCount: number;
    sourceView: CleanupPolicy["sourceView"];
    policy: CleanupPolicy;
    policyHash: string;
    inputContentHash: string;
    outputContentHash: string;
    diagnostics: CleanupDiagnostics;
    semantic?: {
        provider?: string;
        modelId?: string;
        domain?: string;
        quality?: Record<string, number>;
        bestEffortReason?: string;
    };
    handoff?: {
        reportId: string;
        schemaVersion: string;
        verifierPass: boolean;
        quality?: Record<string, number>;
        parentReportIds?: string[];
    };
}

export function buildCleanSessionLines(options: {
    sessionId: string;
    cwd: string;
    title: string;
    body: string;
    imports: SourceRef[];
    manifest: TextualCleanupManifest;
    ir: StoredCleanIr;
    timestamp?: string;
}): Array<Record<string, unknown>> {
    const timestamp = options.timestamp ?? new Date().toISOString();
    const header = {type: "session", version: 3, id: options.sessionId, timestamp, cwd: options.cwd};
    const bodyId = entryId();
    const lines: Array<Record<string, unknown>> = [
        header,
        {
            type: "custom_message",
            id: bodyId,
            parentId: null,
            timestamp,
            customType: "cleanup_text",
            content: [{type: "text", text: options.body}],
            display: true,
            details: {schema: "clean-text/v1", outputContentHash: options.manifest.outputContentHash},
        },
    ];
    const infoId = entryId();
    lines.push({type: "session_info", id: infoId, parentId: bodyId, timestamp, name: options.title});
    let parentId = infoId;
    for (const ref of options.imports) {
        const id = entryId();
        lines.push({type: "custom", id, parentId, timestamp, customType: "import_source", data: ref});
        parentId = id;
    }
    const manifestId = entryId();
    lines.push({type: "custom", id: manifestId, parentId, timestamp, customType: "cleanup_manifest", data: options.manifest});
    parentId = manifestId;
    const irId = entryId();
    lines.push({type: "custom", id: irId, parentId, timestamp, customType: "cleanup_ir", data: options.ir});
    return lines;
}

export function buildCleanSessionLinesFromResult(options: {
    sessionId: string;
    cwd: string;
    title: string;
    imports: SourceRef[];
    manifest: TextualCleanupManifest;
    result: CleanupResult;
    timestamp?: string;
}): Array<Record<string, unknown>> {
    return buildCleanSessionLines({
        ...options,
        body: options.result.text,
        ir: storedIrFromResult(options.result),
    });
}

export function verifyCleanSessionLines(lines: Array<Record<string, unknown>>, expectedBody: string, expectedSessionId: string): void {
    const header = lines[0];
    if (!header || header.type !== "session" || header.version !== 3 || header.id !== expectedSessionId) throw new Error("写后验证失败: session header 无效");
    const bodyEntries = lines.filter((line) => line.type === "custom_message" && line.customType === "cleanup_text");
    if (bodyEntries.length !== 1) throw new Error("写后验证失败: cleanup_text 必须恰好一次");
    const content = bodyEntries[0].content;
    const body = Array.isArray(content) && content[0] && typeof content[0] === "object" ? (content[0] as Record<string, unknown>).text : undefined;
    if (body !== expectedBody) throw new Error("写后验证失败: cleanup_text body 不一致");
    if (lines.filter((line) => line.type === "custom" && line.customType === "cleanup_manifest").length !== 1) throw new Error("写后验证失败: cleanup_manifest 必须恰好一次");
    if (lines.filter((line) => line.type === "custom" && line.customType === "cleanup_ir").length !== 1) throw new Error("写后验证失败: cleanup_ir 必须恰好一次");

    let parentId: string | null = null;
    for (const line of lines.slice(1)) {
        if (line.parentId !== parentId) throw new Error("写后验证失败: 父链不可达");
        if (typeof line.id !== "string" || !line.id) throw new Error("写后验证失败: entry id 无效");
        parentId = line.id;
    }
}


export interface ChunkPartItem {
    sourceId: string;
    chunkIndex: number;
    totalChunks: number;
    partIndex: number;
    text: string;
}

/**
 * 新 --textual 方案:跳过 LLM,把每个 chunk 的每个 chunkPart 作为独立 user message 段写入新会话。
 * 退化 stutter 消息已在生成 chunkPart 前过滤。remnic excerpt 作为独立 part 自然保留。
 */
export function buildChunkPartsSessionLines(options: {
    sessionId: string;
    cwd: string;
    title: string;
    items: ChunkPartItem[];
    imports: SourceRef[];
    manifest: TextualCleanupManifest;
    timestamp?: string;
}): Array<Record<string, unknown>> {
    const timestamp = options.timestamp ?? new Date().toISOString();
    const header = {type: "session", version: 3, id: options.sessionId, timestamp, cwd: options.cwd};
    const lines: Array<Record<string, unknown>> = [header];
    let parentId: string | null = null;
    for (const [index, item] of options.items.entries()) {
        const id = entryId();
        const body = `[chunkPart ${item.chunkIndex + 1}/${item.totalChunks} · ${item.partIndex + 1} | source=${item.sourceId}]
${item.text}`;
        lines.push({
            type: "message",
            id,
            parentId,
            timestamp,
            message: {
                role: "user",
                content: [{type: "text", text: body}],
                timestamp: Date.now() + index, // 区分同秒多条
            },
        });
        parentId = id;
    }
    const infoId = entryId();
    lines.push({type: "session_info", id: infoId, parentId, timestamp, name: options.title});
    parentId = infoId;
    for (const ref of options.imports) {
        const id = entryId();
        lines.push({type: "custom", id, parentId, timestamp, customType: "import_source", data: ref});
        parentId = id;
    }
    const manifestId = entryId();
    lines.push({type: "custom", id: manifestId, parentId, timestamp, customType: "cleanup_manifest", data: options.manifest});
    return lines;
}

export function verifyChunkPartsSessionLines(lines: Array<Record<string, unknown>>, expectedItemCount: number, expectedSessionId: string, expectedManifestHash: string): void {
    const header = lines[0];
    if (!header || header.type !== "session" || header.version !== 3 || header.id !== expectedSessionId) throw new Error("写后验证失败: session header 无效");
    const messages = lines.filter((line) => line.type === "message" && line.message?.role === "user");
    if (messages.length !== expectedItemCount) throw new Error(`写后验证失败: user 段数 ${messages.length} ≠ 预期 ${expectedItemCount}`);
    for (const [index, line] of messages.entries()) {
        const content = line.message?.content;
        const text = Array.isArray(content) && content[0] && typeof content[0] === "object" ? (content[0] as Record<string, unknown>).text : undefined;
        if (typeof text !== "string" || text.length === 0) throw new Error(`写后验证失败: user 段 ${index} 无正文`);
        if (!text.startsWith("[chunkPart ")) throw new Error(`写后验证失败: user 段 ${index} 缺 [chunkPart 头`);
    }
    const manifests = lines.filter((line) => line.type === "custom" && line.customType === "cleanup_manifest");
    if (manifests.length !== 1) throw new Error("写后验证失败: cleanup_manifest 必须恰好一次");
    const data = manifests[0].data as Record<string, unknown> | undefined;
    if (!data || data.outputContentHash !== expectedManifestHash) throw new Error("写后验证失败: cleanup_manifest outputContentHash 不匹配");
    let parentId: string | null = null;
    for (const line of lines.slice(1)) {
        if (line.parentId !== parentId) throw new Error("写后验证失败: 父链不可达");
        if (typeof line.id !== "string" || !line.id) throw new Error("写后验证失败: entry id 无效");
        parentId = line.id;
    }
}


export function buildHandoffSessionLines(options: {
    sessionId: string;
    cwd: string;
    title: string;
    body: string;
    imports: SourceRef[];
    manifest: TextualCleanupManifest;
    report: AgentHandoffReport;
    timestamp?: string;
}): Array<Record<string, unknown>> {
    const timestamp = options.timestamp ?? new Date().toISOString();
    const header = {type: "session", version: 3, id: options.sessionId, timestamp, cwd: options.cwd};
    const bodyId = entryId();
    const lines: Array<Record<string, unknown>> = [
        header,
        {
            type: "custom_message",
            id: bodyId,
            parentId: null,
            timestamp,
            customType: "cleanup_text",
            content: [{type: "text", text: options.body}],
            display: true,
            details: {
                schema: "agent-handoff-markdown/v1",
                reportId: options.report.reportId,
                normalizedContentHash: options.report.quality.normalizedContentHash,
            },
        },
    ];
    const infoId = entryId();
    lines.push({type: "session_info", id: infoId, parentId: bodyId, timestamp, name: options.title});
    let parentId = infoId;
    for (const ref of options.imports) {
        const id = entryId();
        lines.push({type: "custom", id, parentId, timestamp, customType: "import_source", data: ref});
        parentId = id;
    }
    const manifestId = entryId();
    lines.push({type: "custom", id: manifestId, parentId, timestamp, customType: "cleanup_manifest", data: options.manifest});
    parentId = manifestId;
    const reportEntryId = entryId();
    lines.push({type: "custom", id: reportEntryId, parentId, timestamp, customType: "cleanup_handoff", data: options.report});
    return lines;
}

export function verifyHandoffSessionLines(
    lines: Array<Record<string, unknown>>,
    expectedBody: string,
    expectedSessionId: string,
    expectedReportId: string,
): void {
    const header = lines[0];
    if (!header || header.type !== "session" || header.version !== 3 || header.id !== expectedSessionId) throw new Error("写后验证失败: session header 无效");
    const bodyEntries = lines.filter((line) => line.type === "custom_message" && line.customType === "cleanup_text");
    if (bodyEntries.length !== 1) throw new Error("写后验证失败: cleanup_text 必须恰好一次");
    const content = bodyEntries[0].content;
    const body = Array.isArray(content) && content[0] && typeof content[0] === "object" ? (content[0] as Record<string, unknown>).text : undefined;
    if (body !== expectedBody) throw new Error("写后验证失败: handoff body 不一致");
    if (lines.filter((line) => line.type === "custom" && line.customType === "cleanup_manifest").length !== 1) throw new Error("写后验证失败: cleanup_manifest 必须恰好一次");
    const reports = lines.filter((line) => line.type === "custom" && line.customType === "cleanup_handoff");
    if (reports.length !== 1) throw new Error("写后验证失败: cleanup_handoff 必须恰好一次");
    const report = reports[0].data as Record<string, unknown> | undefined;
    if (!report || report.reportId !== expectedReportId) throw new Error("写后验证失败: cleanup_handoff reportId 不匹配");
    if (lines.some((line) => line.type === "custom" && line.customType === "cleanup_ir")) throw new Error("写后验证失败: handoff session 不应混入 textual cleanup_ir");

    let parentId: string | null = null;
    for (const line of lines.slice(1)) {
        if (line.parentId !== parentId) throw new Error("写后验证失败: 父链不可达");
        if (typeof line.id !== "string" || !line.id) throw new Error("写后验证失败: entry id 无效");
        parentId = line.id;
    }
}
