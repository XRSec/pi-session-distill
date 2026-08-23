import assert from "node:assert/strict";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {gunzipSync} from "node:zlib";
import {
    buildHiddenHistoryArchive,
    hiddenHistoryArchiveFromSessionLines,
    verifyHiddenHistoryArchive,
    verifyHiddenHistorySessionLines,
} from "../history.ts";
import {buildHandoffSessionLines, verifyHandoffSessionLines} from "../session-writer.ts";

function session(lines) {
    return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

test("完整保存多来源 session tree 并生成全局时间线", () => {
    const directory = mkdtempSync(join(tmpdir(), "session-distill-history-test-"));
    try {
        const first = join(directory, "first.jsonl");
        const second = join(directory, "second.jsonl");
        const firstRaw = session([
            {type: "session", version: 3, id: "source-a", timestamp: "2026-01-02T00:00:00.000Z", cwd: "/repo"},
            {
                type: "message",
                id: "a1",
                parentId: null,
                timestamp: "2026-01-02T00:00:02.000Z",
                message: {role: "user", content: "secret=token-original", timestamp: 1767312002000}
            },
            {
                type: "message",
                id: "a2",
                parentId: "a1",
                timestamp: "2026-01-02T00:00:04.000Z",
                message: {
                    role: "assistant",
                    content: [{type: "thinking", thinking: "private reasoning"}, {type: "text", text: "done"}]
                }
            },
            {
                type: "message",
                id: "a-branch",
                parentId: "a1",
                timestamp: "2026-01-02T00:00:03.000Z",
                message: {role: "user", content: "alternate branch"}
            },
        ]);
        const secondRaw = session([
            {type: "session", version: 3, id: "source-b", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/repo"},
            {
                type: "message",
                id: "b1",
                parentId: null,
                timestamp: "2026-01-01T00:00:01.000Z",
                message: {role: "user", content: [{type: "image", data: "base64-payload", mimeType: "image/png"}]}
            },
        ]);
        writeFileSync(first, firstRaw, {mode: 0o600});
        writeFileSync(second, secondRaw, {mode: 0o600});

        const archive = buildHiddenHistoryArchive([
            {sourceId: "source-a", sourceIndex: 0, filePath: first},
            {sourceId: "source-b", sourceIndex: 1, filePath: second},
        ]);
        verifyHiddenHistoryArchive(archive);
        assert.equal(archive.manifest.scope, "full-session-tree");
        assert.equal(archive.manifest.exactSourceBytes, true);
        assert.equal(archive.manifest.recordCount, 6);

        const timeline = archive.timelineChunks.flatMap((chunk) => chunk.records);
        assert.deepEqual(timeline.map((record) => record.entryId ?? record.type), ["source-b", "b1", "source-a", "a1", "a-branch", "a2"]);

        const firstEncoded = archive.sourceChunks
            .filter((chunk) => chunk.sourceId === "source-a")
            .sort((left, right) => left.chunkIndex - right.chunkIndex)
            .map((chunk) => chunk.data)
            .join("");
        assert.equal(gunzipSync(Buffer.from(firstEncoded, "base64")).toString("utf8"), firstRaw);

        const lines = [
            {type: "custom", customType: "cleanup_history_manifest", data: archive.manifest},
            ...archive.sourceChunks.map((data) => ({type: "custom", customType: "cleanup_history_source_chunk", data})),
            ...archive.timelineChunks.map((data) => ({
                type: "custom",
                customType: "cleanup_history_timeline_chunk",
                data
            })),
        ];
        assert.equal(hiddenHistoryArchiveFromSessionLines(lines)?.manifest.archiveId, archive.manifest.archiveId);
        verifyHiddenHistorySessionLines(lines, archive.manifest.archiveId);
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
});

test("handoff session 以 hidden custom entries 持久化并回读完整历史", () => {
    const directory = mkdtempSync(join(tmpdir(), "session-distill-history-writer-"));
    try {
        const paths = [join(directory, "a.jsonl"), join(directory, "b.jsonl")];
        paths.forEach((filePath, index) => writeFileSync(filePath, session([
            {
                type: "session",
                version: 3,
                id: `writer-${index}`,
                timestamp: `2026-02-0${index + 1}T00:00:00.000Z`,
                cwd: "/repo"
            },
            {
                type: "message",
                id: `w${index}-root`,
                parentId: null,
                timestamp: `2026-02-0${index + 1}T00:00:01.000Z`,
                message: {role: "user", content: `source ${index}`}
            },
            {
                type: "message",
                id: `w${index}-main`,
                parentId: `w${index}-root`,
                timestamp: `2026-02-0${index + 1}T00:00:02.000Z`,
                message: {role: "assistant", content: [{type: "text", text: "main"}]}
            },
            {
                type: "message",
                id: `w${index}-branch`,
                parentId: `w${index}-root`,
                timestamp: `2026-02-0${index + 1}T00:00:03.000Z`,
                message: {role: "assistant", content: [{type: "text", text: "branch"}]}
            },
            {
                type: "custom_message",
                id: `w${index}-old-clean`,
                parentId: `w${index}-main`,
                timestamp: `2026-02-0${index + 1}T00:00:04.000Z`,
                customType: "cleanup_text",
                content: [{type: "text", text: "old handoff"}],
                display: true,
                details: {reportId: `old-${index}`}
            },
            {
                type: "custom",
                id: `w${index}-old-report`,
                parentId: `w${index}-old-clean`,
                timestamp: `2026-02-0${index + 1}T00:00:05.000Z`,
                customType: "cleanup_handoff",
                data: {reportId: `old-${index}`}
            },
        ])));
        const history = buildHiddenHistoryArchive(paths.map((filePath, sourceIndex) => ({
            sourceId: `writer-${sourceIndex}`,
            sourceIndex,
            filePath
        })));
        const report = {reportId: "report-test", quality: {normalizedContentHash: "content-hash"}};
        const manifest = {
            schemaVersion: 5,
            cleanerVersion: "test",
            runId: "run-test",
            createdAt: "2026-02-03T00:00:00.000Z",
            mode: "handoff",
            directSources: [],
            sourceCount: 2,
            sourceView: "active-branch",
            policy: {sourceView: "active-branch"},
            policyHash: "policy",
            inputContentHash: "input",
            outputContentHash: "output",
            diagnostics: {},
        };
        const lines = buildHandoffSessionLines({
            sessionId: "output-session",
            cwd: "/repo",
            title: "Merged handoff",
            body: "Visible handoff",
            imports: [],
            manifest,
            report,
            history,
        });
        verifyHandoffSessionLines(lines, "Visible handoff", "output-session", "report-test", history.manifest.archiveId);
        assert.equal(lines.filter((line) => line.customType === "cleanup_history_manifest").length, 1);
        assert.equal(lines.filter((line) => line.customType === "cleanup_history_source_chunk").length, history.sourceChunks.length);
        assert.ok(lines.filter((line) => line.customType?.startsWith("cleanup_history_")).every((line) => line.type === "custom"));
        const mergeRoot = lines.find((line) => line.customType === "cleanup_merge_root");
        assert.ok(mergeRoot);
        assert.equal(lines.filter((line) => line.customType === "cleanup_source_root" && line.parentId === mergeRoot.id).length, 2);
        const handoff = lines.find((line) => line.type === "compaction" && line.details?.reportId === "report-test");
        assert.equal(handoff?.parentId, mergeRoot.id);
        assert.equal(handoff?.summary, "Visible handoff");
        assert.equal(handoff?.firstKeptEntryId, handoff?.id);
        assert.equal(handoff?.fromHook, true);
        assert.equal(lines.filter((line) => line.type === "message").length, 6);
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
});

test("任一压缩块被篡改时验证失败", () => {
    const directory = mkdtempSync(join(tmpdir(), "session-distill-history-tamper-"));
    try {
        const paths = [join(directory, "a.jsonl"), join(directory, "b.jsonl")];
        paths.forEach((filePath, index) => writeFileSync(filePath, session([
            {
                type: "session",
                version: 3,
                id: `s${index}`,
                timestamp: `2026-01-0${index + 1}T00:00:00.000Z`,
                cwd: "/repo"
            },
        ])));
        const archive = buildHiddenHistoryArchive(paths.map((filePath, sourceIndex) => ({
            sourceId: `s${sourceIndex}`,
            sourceIndex,
            filePath
        })));
        archive.sourceChunks[0].data = `${archive.sourceChunks[0].data[0] === "A" ? "B" : "A"}${archive.sourceChunks[0].data.slice(1)}`;
        assert.throws(() => verifyHiddenHistoryArchive(archive), /隐藏历史(?:读取|验证)失败/);
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
});
