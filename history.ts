import * as crypto from "node:crypto";
import * as fs from "node:fs";
import {gunzipSync, gzipSync} from "node:zlib";

const SOURCE_CHUNK_CHARS = 512 * 1024;
const TIMELINE_RECORDS_PER_CHUNK = 1000;

function sha256(value: string | Buffer): string {
    return crypto.createHash("sha256").update(value).digest("hex");
}

export interface HistorySourceInput {
    sourceId: string;
    sourceIndex: number;
    filePath: string;
    name?: string;
    timestamp?: string;
}

export interface HiddenHistoryTimelineRecord {
    sourceId: string;
    sourceIndex: number;
    lineIndex: number;
    type: string;
    entryId?: string;
    parentId?: string | null;
    timestamp: string | number | null;
    timestampMs: number | null;
    rawLineSha256: string;
}

export interface HiddenHistoryManifest {
    schema: "session-distill-hidden-history/v1";
    archiveId: string;
    createdAt: string;
    scope: "full-session-tree";
    exactSourceBytes: true;
    encoding: "gzip+base64";
    ordering: "timestamp-source-line";
    sourceCount: number;
    recordCount: number;
    timelineSha256: string;
    sources: Array<{
        sourceId: string;
        sourceIndex: number;
        sha256: string;
        bytes: number;
        compressedSha256: string;
        compressedBytes: number;
        chunkCount: number;
        lineCount: number;
        name?: string;
        timestamp?: string;
    }>;
}

export interface HiddenHistorySourceChunk {
    schemaVersion: 1;
    sourceId: string;
    sourceIndex: number;
    chunkIndex: number;
    totalChunks: number;
    data: string;
}

export interface HiddenHistoryTimelineChunk {
    schemaVersion: 1;
    chunkIndex: number;
    totalChunks: number;
    records: HiddenHistoryTimelineRecord[];
}

export interface HiddenHistoryArchive {
    manifest: HiddenHistoryManifest;
    sourceChunks: HiddenHistorySourceChunk[];
    timelineChunks: HiddenHistoryTimelineChunk[];
}

function sourceLines(raw: Buffer, sourceId: string): Array<{ rawLine: string; parsed: Record<string, unknown> }> {
    const lines = raw.toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines.map((rawLine, lineIndex) => {
        try {
            return {rawLine, parsed: JSON.parse(rawLine) as Record<string, unknown>};
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`隐藏历史读取失败: source=${sourceId} line=${lineIndex + 1} (${message})`);
        }
    });
}

function recordTimestamp(entry: Record<string, unknown>): string | number | null {
    if (typeof entry.timestamp === "string" || typeof entry.timestamp === "number") return entry.timestamp;
    const message = entry.message;
    if (message && typeof message === "object" && !Array.isArray(message)) {
        const timestamp = (message as Record<string, unknown>).timestamp;
        if (typeof timestamp === "string" || typeof timestamp === "number") return timestamp;
    }
    return null;
}

function timestampMs(value: string | number | null): number | null {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string") {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function splitText(value: string, chunkChars: number): string[] {
    const chunks: string[] = [];
    for (let offset = 0; offset < value.length; offset += chunkChars) chunks.push(value.slice(offset, offset + chunkChars));
    return chunks.length > 0 ? chunks : [""];
}

function compareTimeline(left: HiddenHistoryTimelineRecord, right: HiddenHistoryTimelineRecord): number {
    if (left.timestampMs !== right.timestampMs) {
        if (left.timestampMs === null) return 1;
        if (right.timestampMs === null) return -1;
        return left.timestampMs - right.timestampMs;
    }
    return left.sourceIndex - right.sourceIndex || left.lineIndex - right.lineIndex;
}

function archiveIdFor(manifest: Omit<HiddenHistoryManifest, "archiveId" | "createdAt">): string {
    return `hist-${sha256(JSON.stringify(manifest)).slice(0, 24)}`;
}

export function buildHiddenHistoryArchive(inputs: HistorySourceInput[]): HiddenHistoryArchive {
    if (inputs.length < 2) throw new Error("隐藏完整历史仅用于多会话 handoff");
    const sourceChunks: HiddenHistorySourceChunk[] = [];
    const timeline: HiddenHistoryTimelineRecord[] = [];
    const sources: HiddenHistoryManifest["sources"] = [];

    for (const input of inputs) {
        const raw = fs.readFileSync(input.filePath);
        const compressed = gzipSync(raw, {level: 9});
        const encodedChunks = splitText(compressed.toString("base64"), SOURCE_CHUNK_CHARS);
        const lines = sourceLines(raw, input.sourceId);
        sources.push({
            sourceId: input.sourceId,
            sourceIndex: input.sourceIndex,
            sha256: sha256(raw),
            bytes: raw.length,
            compressedSha256: sha256(compressed),
            compressedBytes: compressed.length,
            chunkCount: encodedChunks.length,
            lineCount: lines.length,
            ...(input.name ? {name: input.name} : {}),
            ...(input.timestamp ? {timestamp: input.timestamp} : {}),
        });
        encodedChunks.forEach((data, chunkIndex) => sourceChunks.push({
            schemaVersion: 1,
            sourceId: input.sourceId,
            sourceIndex: input.sourceIndex,
            chunkIndex,
            totalChunks: encodedChunks.length,
            data,
        }));
        lines.forEach(({rawLine, parsed}, lineIndex) => {
            const timestamp = recordTimestamp(parsed);
            timeline.push({
                sourceId: input.sourceId,
                sourceIndex: input.sourceIndex,
                lineIndex,
                type: typeof parsed.type === "string" ? parsed.type : "unknown",
                ...(typeof parsed.id === "string" ? {entryId: parsed.id} : {}),
                ...(typeof parsed.parentId === "string" || parsed.parentId === null ? {parentId: parsed.parentId as string | null} : {}),
                timestamp,
                timestampMs: timestampMs(timestamp),
                rawLineSha256: sha256(rawLine),
            });
        });
    }

    timeline.sort(compareTimeline);
    const timelineSha256 = sha256(JSON.stringify(timeline));
    const manifestWithoutIdentity = {
        schema: "session-distill-hidden-history/v1" as const,
        scope: "full-session-tree" as const,
        exactSourceBytes: true as const,
        encoding: "gzip+base64" as const,
        ordering: "timestamp-source-line" as const,
        sourceCount: sources.length,
        recordCount: timeline.length,
        timelineSha256,
        sources,
    };
    const manifest: HiddenHistoryManifest = {
        ...manifestWithoutIdentity,
        archiveId: archiveIdFor(manifestWithoutIdentity),
        createdAt: new Date().toISOString(),
    };
    const totalTimelineChunks = Math.max(1, Math.ceil(timeline.length / TIMELINE_RECORDS_PER_CHUNK));
    const timelineChunks: HiddenHistoryTimelineChunk[] = Array.from({length: totalTimelineChunks}, (_, chunkIndex) => ({
        schemaVersion: 1,
        chunkIndex,
        totalChunks: totalTimelineChunks,
        records: timeline.slice(chunkIndex * TIMELINE_RECORDS_PER_CHUNK, (chunkIndex + 1) * TIMELINE_RECORDS_PER_CHUNK),
    }));
    const archive = {manifest, sourceChunks, timelineChunks};
    verifyHiddenHistoryArchive(archive);
    return archive;
}

export function hiddenHistorySourceBytes(archive: HiddenHistoryArchive, sourceId: string): Buffer {
    const source = archive.manifest.sources.find((item) => item.sourceId === sourceId);
    if (!source) throw new Error(`隐藏历史读取失败: 未找到来源 ${sourceId}`);
    const chunks = archive.sourceChunks
        .filter((chunk) => chunk.sourceId === source.sourceId && chunk.sourceIndex === source.sourceIndex)
        .sort((left, right) => left.chunkIndex - right.chunkIndex);
    if (chunks.length !== source.chunkCount || chunks.some((chunk, index) => chunk.chunkIndex !== index || chunk.totalChunks !== chunks.length)) {
        throw new Error(`隐藏历史读取失败: source chunk 不完整 (${source.sourceId})`);
    }
    const compressed = Buffer.from(chunks.map((chunk) => chunk.data).join(""), "base64");
    if (compressed.length !== source.compressedBytes || sha256(compressed) !== source.compressedSha256) {
        throw new Error(`隐藏历史读取失败: compressed source 不一致 (${source.sourceId})`);
    }
    const raw = gunzipSync(compressed);
    if (raw.length !== source.bytes || sha256(raw) !== source.sha256) throw new Error(`隐藏历史读取失败: source bytes 不一致 (${source.sourceId})`);
    return raw;
}

export function verifyHiddenHistoryArchive(archive: HiddenHistoryArchive): void {
    const {manifest} = archive;
    if (manifest.schema !== "session-distill-hidden-history/v1" || manifest.scope !== "full-session-tree") {
        throw new Error("隐藏历史验证失败: manifest schema/scope 无效");
    }
    if (manifest.sourceCount !== manifest.sources.length || manifest.sourceCount < 2) throw new Error("隐藏历史验证失败: sourceCount 无效");
    const sourceLinesById = new Map<string, Array<{ rawLine: string; parsed: Record<string, unknown> }>>();
    for (const source of manifest.sources) {
        const raw = hiddenHistorySourceBytes(archive, source.sourceId);
        const lines = sourceLines(raw, source.sourceId);
        if (lines.length !== source.lineCount) throw new Error(`隐藏历史验证失败: lineCount 不一致 (${source.sourceId})`);
        sourceLinesById.set(source.sourceId, lines);
    }

    const timelineChunks = [...archive.timelineChunks].sort((left, right) => left.chunkIndex - right.chunkIndex);
    if (timelineChunks.length === 0 || timelineChunks.some((chunk, index) => chunk.chunkIndex !== index || chunk.totalChunks !== timelineChunks.length)) {
        throw new Error("隐藏历史验证失败: timeline chunk 不完整");
    }
    const timeline = timelineChunks.flatMap((chunk) => chunk.records);
    if (timeline.length !== manifest.recordCount || sha256(JSON.stringify(timeline)) !== manifest.timelineSha256) {
        throw new Error("隐藏历史验证失败: timeline hash/count 不一致");
    }
    for (let index = 1; index < timeline.length; index++) {
        if (compareTimeline(timeline[index - 1], timeline[index]) > 0) throw new Error("隐藏历史验证失败: timeline 未按时间排序");
    }
    for (const record of timeline) {
        const line = sourceLinesById.get(record.sourceId)?.[record.lineIndex];
        if (!line || sha256(line.rawLine) !== record.rawLineSha256) throw new Error(`隐藏历史验证失败: timeline 行引用无效 (${record.sourceId}:${record.lineIndex})`);
    }
    const {archiveId: _, createdAt: __, ...manifestWithoutIdentity} = manifest;
    if (archiveIdFor(manifestWithoutIdentity) !== manifest.archiveId) throw new Error("隐藏历史验证失败: archiveId 不一致");
}

export function hiddenHistoryArchiveFromSessionLines(lines: Array<Record<string, unknown>>): HiddenHistoryArchive | undefined {
    const manifests = lines.filter((line) => line.type === "custom" && line.customType === "cleanup_history_manifest");
    if (manifests.length === 0) return undefined;
    if (manifests.length !== 1) throw new Error("隐藏历史验证失败: manifest 必须恰好一次");
    const manifest = manifests[0].data as HiddenHistoryManifest;
    const sourceChunks = lines
        .filter((line) => line.type === "custom" && line.customType === "cleanup_history_source_chunk")
        .map((line) => line.data as HiddenHistorySourceChunk);
    const timelineChunks = lines
        .filter((line) => line.type === "custom" && line.customType === "cleanup_history_timeline_chunk")
        .map((line) => line.data as HiddenHistoryTimelineChunk);
    return {manifest, sourceChunks, timelineChunks};
}

export function verifyHiddenHistorySessionLines(lines: Array<Record<string, unknown>>, expectedArchiveId: string): void {
    const archive = hiddenHistoryArchiveFromSessionLines(lines);
    if (!archive) throw new Error("隐藏历史验证失败: session 中缺少 archive");
    if (archive.manifest.archiveId !== expectedArchiveId) throw new Error("隐藏历史验证失败: session archiveId 不一致");
    verifyHiddenHistoryArchive(archive);
}
