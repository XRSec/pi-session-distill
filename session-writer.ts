import * as crypto from "crypto";
import type {SourceRef} from "./core.ts";
import type {CleanupDiagnostics, CleanupPolicy, CleanupResult, StoredCleanIr} from "./textual.ts";
import {storedIrFromResult} from "./textual.ts";
import type {AgentHandoffReport} from "./handoff.ts";
import type {HiddenHistoryArchive} from "./history.ts";
import {
    hiddenHistoryArchiveFromSessionLines,
    hiddenHistorySourceBytes,
    verifyHiddenHistorySessionLines
} from "./history.ts";

function entryId(): string {
    return crypto.randomBytes(4).toString("hex");
}

function parseHistorySourceEntries(history: HiddenHistoryArchive, sourceId: string): {
    header: Record<string, unknown>;
    entries: Array<Record<string, unknown>>
} {
    const lines = hiddenHistorySourceBytes(history, sourceId).toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const parsed = lines.map((line, index) => {
        try {
            return JSON.parse(line) as Record<string, unknown>;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`来源树读取失败: source=${sourceId} line=${index + 1} (${message})`);
        }
    });
    const [header, ...entries] = parsed;
    if (!header || header.type !== "session" || header.id !== sourceId) throw new Error(`来源树读取失败: header 无效 (${sourceId})`);
    return {header, entries};
}

function appendMergedSourceBranches(lines: Array<Record<string, unknown>>, rootId: string, fallbackTimestamp: string, history: HiddenHistoryArchive): void {
    for (const source of [...history.manifest.sources].sort((left, right) => left.sourceIndex - right.sourceIndex)) {
        const {header, entries} = parseHistorySourceEntries(history, source.sourceId);
        const markerId = entryId();
        const markerTimestamp = source.timestamp ?? (typeof header.timestamp === "string" ? header.timestamp : fallbackTimestamp);
        lines.push({
            type: "custom_message",
            id: markerId,
            parentId: rootId,
            timestamp: markerTimestamp,
            customType: "cleanup_source_root",
            content: [{type: "text", text: `完整来源会话：${source.name || source.sourceId}`}],
            display: true,
            details: {sourceId: source.sourceId, sourceSha256: source.sha256, originalEntryCount: entries.length},
        });
        const idMap = new Map<string, string>();
        for (const entry of entries) {
            if (typeof entry.id !== "string" || !entry.id || idMap.has(entry.id)) throw new Error(`来源树读取失败: entry id 无效或重复 (${source.sourceId})`);
            idMap.set(entry.id, entryId());
        }
        for (const entry of entries) {
            const originalParent = entry.parentId;
            if (originalParent !== null && typeof originalParent !== "string") throw new Error(`来源树读取失败: parentId 无效 (${source.sourceId}:${String(entry.id)})`);
            const parentId = originalParent === null ? markerId : idMap.get(originalParent);
            if (!parentId) throw new Error(`来源树读取失败: parentId 不可解析 (${source.sourceId}:${String(entry.id)})`);
            lines.push({...entry, id: idMap.get(entry.id as string), parentId});
        }
    }
}

function activePathEntries(lines: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    const entries = lines.slice(1);
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const path: Array<Record<string, unknown>> = [];
    const visited = new Set<string>();
    let current = entries.at(-1);
    while (current) {
        if (typeof current.id !== "string" || visited.has(current.id)) throw new Error("写后验证失败: active path 存在无效 id 或环");
        visited.add(current.id);
        path.unshift(current);
        if (current.parentId === null) break;
        current = typeof current.parentId === "string" ? byId.get(current.parentId) : undefined;
        if (!current) throw new Error("写后验证失败: active path parentId 不存在");
    }
    return path;
}

function verifyEntryTree(lines: Array<Record<string, unknown>>): void {
    const entries = lines.slice(1);
    const byId = new Map<string, Record<string, unknown>>();
    for (const entry of entries) {
        if (typeof entry.id !== "string" || !entry.id || byId.has(entry.id)) throw new Error("写后验证失败: entry id 无效或重复");
        byId.set(entry.id, entry);
    }
    const roots = entries.filter((entry) => entry.parentId === null);
    if (roots.length !== 1) throw new Error(`写后验证失败: session tree 必须恰好一个根，实际 ${roots.length}`);
    const children = new Map<string, string[]>();
    for (const entry of entries) {
        if (entry.parentId === null) continue;
        if (typeof entry.parentId !== "string" || !byId.has(entry.parentId)) throw new Error("写后验证失败: parentId 不存在");
        const bucket = children.get(entry.parentId) ?? [];
        bucket.push(entry.id as string);
        children.set(entry.parentId, bucket);
    }
    const visited = new Set<string>();
    const stack = [roots[0].id as string];
    while (stack.length > 0) {
        const id = stack.pop()!;
        if (visited.has(id)) throw new Error("写后验证失败: session tree 存在环");
        visited.add(id);
        stack.push(...(children.get(id) ?? []));
    }
    if (visited.size !== entries.length) throw new Error("写后验证失败: session tree 存在不可达 entry");
}

function verifyMergedSourceBranches(lines: Array<Record<string, unknown>>, history: HiddenHistoryArchive): void {
    const roots = lines.filter((line) => line.type === "custom" && line.customType === "cleanup_merge_root");
    if (roots.length !== 1 || typeof roots[0].id !== "string") throw new Error("写后验证失败: cleanup_merge_root 必须恰好一次");
    const rootId = roots[0].id as string;
    const markers = lines.filter((line) => line.type === "custom_message" && line.customType === "cleanup_source_root" && line.parentId === rootId);
    if (markers.length !== history.manifest.sourceCount) throw new Error("写后验证失败: 来源分支数量不一致");
    const summaryIndex = lines.findIndex((line) => line.type === "compaction" && line.parentId === rootId && (line.details as Record<string, unknown> | undefined)?.schema === "agent-handoff-markdown/v1");
    if (summaryIndex < 0) throw new Error("写后验证失败: 聚合摘要不在 active 根分支");

    for (const source of [...history.manifest.sources].sort((left, right) => left.sourceIndex - right.sourceIndex)) {
        const markerIndex = lines.findIndex((line) => line.type === "custom_message" && line.customType === "cleanup_source_root" && line.parentId === rootId && (line.details as Record<string, unknown> | undefined)?.sourceId === source.sourceId);
        if (markerIndex < 0) throw new Error(`写后验证失败: 缺少来源分支 ${source.sourceId}`);
        const nextBoundary = lines.findIndex((line, index) => index > markerIndex && ((line.type === "custom_message" && line.customType === "cleanup_source_root" && line.parentId === rootId) || index === summaryIndex));
        const imported = lines.slice(markerIndex + 1, nextBoundary < 0 ? summaryIndex : nextBoundary);
        const original = parseHistorySourceEntries(history, source.sourceId).entries;
        if (imported.length !== original.length) throw new Error(`写后验证失败: 来源分支 entry 数量不一致 (${source.sourceId})`);
        const idMap = new Map<string, string>();
        for (let index = 0; index < original.length; index++) idMap.set(original[index].id as string, imported[index].id as string);
        for (let index = 0; index < original.length; index++) {
            const expected = {
                ...original[index],
                id: idMap.get(original[index].id as string),
                parentId: original[index].parentId === null ? lines[markerIndex].id : idMap.get(original[index].parentId as string),
            };
            if (JSON.stringify(imported[index]) !== JSON.stringify(expected)) throw new Error(`写后验证失败: 来源分支内容不一致 (${source.sourceId}:${index})`);
        }
    }
}

export interface TextualCleanupManifest {
    schemaVersion: 3 | 4 | 5;
    cleanerVersion: string;
    runId: string;
    createdAt: string;
    mode: "textual" | "capsule" | "handoff";
    directSources: SourceRef[];
    sourceSnapshots?: Array<{ sourceId: string; sha256: string; bytes: number }>;
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
    history?: {
        archiveId: string;
        schema: string;
        scope: "full-session-tree";
        exactSourceBytes: true;
        sourceCount: number;
        recordCount: number;
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
    lines.push({
        type: "custom",
        id: manifestId,
        parentId,
        timestamp,
        customType: "cleanup_manifest",
        data: options.manifest
    });
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
    lines.push({
        type: "custom",
        id: manifestId,
        parentId,
        timestamp,
        customType: "cleanup_manifest",
        data: options.manifest
    });
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
    history?: HiddenHistoryArchive;
    timestamp?: string;
}): Array<Record<string, unknown>> {
    const timestamp = options.timestamp ?? new Date().toISOString();
    const header = {type: "session", version: 3, id: options.sessionId, timestamp, cwd: options.cwd};
    const lines: Array<Record<string, unknown>> = [header];
    let activeParentId: string | null = null;
    if (options.history) {
        const rootId = entryId();
        lines.push({
            type: "custom",
            id: rootId,
            parentId: null,
            timestamp,
            customType: "cleanup_merge_root",
            data: {schema: "session-distill-merge-tree/v1", archiveId: options.history.manifest.archiveId},
        });
        appendMergedSourceBranches(lines, rootId, timestamp, options.history);
        activeParentId = rootId;
    }
    const bodyId = entryId();
    lines.push({
        type: "compaction",
        id: bodyId,
        parentId: activeParentId,
        timestamp,
        summary: options.body,
        firstKeptEntryId: bodyId,
        tokensBefore: 0,
        fromHook: true,
        details: {
            schema: "agent-handoff-markdown/v1",
            reportId: options.report.reportId,
            normalizedContentHash: options.report.quality.normalizedContentHash,
        },
    });
    const infoId = entryId();
    lines.push({type: "session_info", id: infoId, parentId: bodyId, timestamp, name: options.title});
    let parentId = infoId;
    for (const ref of options.imports) {
        const id = entryId();
        lines.push({type: "custom", id, parentId, timestamp, customType: "import_source", data: ref});
        parentId = id;
    }
    const manifestId = entryId();
    lines.push({
        type: "custom",
        id: manifestId,
        parentId,
        timestamp,
        customType: "cleanup_manifest",
        data: options.manifest
    });
    parentId = manifestId;
    const reportEntryId = entryId();
    lines.push({
        type: "custom",
        id: reportEntryId,
        parentId,
        timestamp,
        customType: "cleanup_handoff",
        data: options.report
    });
    parentId = reportEntryId;
    if (options.history) {
        const historyManifestId = entryId();
        lines.push({
            type: "custom",
            id: historyManifestId,
            parentId,
            timestamp,
            customType: "cleanup_history_manifest",
            data: options.history.manifest
        });
        parentId = historyManifestId;
        for (const chunk of options.history.sourceChunks) {
            const id = entryId();
            lines.push({
                type: "custom",
                id,
                parentId,
                timestamp,
                customType: "cleanup_history_source_chunk",
                data: chunk
            });
            parentId = id;
        }
        for (const chunk of options.history.timelineChunks) {
            const id = entryId();
            lines.push({
                type: "custom",
                id,
                parentId,
                timestamp,
                customType: "cleanup_history_timeline_chunk",
                data: chunk
            });
            parentId = id;
        }
    }
    return lines;
}

export function verifyHandoffSessionLines(
    lines: Array<Record<string, unknown>>,
    expectedBody: string,
    expectedSessionId: string,
    expectedReportId: string,
    expectedHistoryArchiveId?: string,
): void {
    const header = lines[0];
    if (!header || header.type !== "session" || header.version !== 3 || header.id !== expectedSessionId) throw new Error("写后验证失败: session header 无效");
    const activeEntries = activePathEntries(lines);
    const bodyEntries = activeEntries.filter((line) => {
        const details = line.details as Record<string, unknown> | undefined;
        return line.type === "compaction" && details?.schema === "agent-handoff-markdown/v1";
    });
    if (bodyEntries.length !== 1) throw new Error("写后验证失败: active handoff compaction 必须恰好一次");
    const bodyEntry = bodyEntries[0];
    if (bodyEntry.summary !== expectedBody) throw new Error("写后验证失败: handoff body 不一致");
    if (bodyEntry.firstKeptEntryId !== bodyEntry.id) throw new Error("写后验证失败: handoff compaction 必须是自包含 checkpoint");
    if (activeEntries.filter((line) => line.type === "custom" && line.customType === "cleanup_manifest").length !== 1) throw new Error("写后验证失败: active cleanup_manifest 必须恰好一次");
    const reports = activeEntries.filter((line) => line.type === "custom" && line.customType === "cleanup_handoff");
    if (reports.length !== 1) throw new Error("写后验证失败: active cleanup_handoff 必须恰好一次");
    const report = reports[0].data as Record<string, unknown> | undefined;
    if (!report || report.reportId !== expectedReportId) throw new Error("写后验证失败: cleanup_handoff reportId 不匹配");
    if (activeEntries.some((line) => line.type === "custom" && line.customType === "cleanup_ir")) throw new Error("写后验证失败: active handoff branch 不应混入 textual cleanup_ir");
    if (expectedHistoryArchiveId) {
        verifyHiddenHistorySessionLines(activeEntries, expectedHistoryArchiveId);
        const history = hiddenHistoryArchiveFromSessionLines(activeEntries);
        if (!history) throw new Error("写后验证失败: 缺少 hidden history");
        verifyMergedSourceBranches(lines, history);
    } else if (activeEntries.some((line) => line.type === "custom" && String(line.customType).startsWith("cleanup_history_"))) {
        throw new Error("写后验证失败: 未预期的 hidden history");
    }
    verifyEntryTree(lines);
}
