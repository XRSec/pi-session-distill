import test from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_POLICY,
    canonicalizeText,
    cleanupDocuments,
    documentFromEntries,
    mergePolicy,
    projectEntries,
    redactSecrets,
    storedIrFromResult,
    type CleanDocument,
    type VisibleSegment,
} from "../textual.ts";
import {buildCleanSessionLinesFromResult, verifyCleanSessionLines, type TextualCleanupManifest} from "../session-writer.ts";

function seg(kind: VisibleSegment["kind"], text: string, sourceId: string, order: number): VisibleSegment {
    return {kind, text, sourceId, sourceOrder: order, fidelity: kind === "checkpoint" ? "derived" : "verbatim"};
}

function doc(sourceId: string, values: Array<[VisibleSegment["kind"], string]>, sourceIndex = 0): CleanDocument {
    return {
        schema: "clean-text/v1",
        sourceId,
        sourceIndex,
        segments: values.map(([kind, text], index) => seg(kind, text, sourceId, index)),
    };
}

test("canonical normalization is idempotent and preserves code indentation", () => {
    const input = "\r\nhello   \r\n\r\n\r\n\r\n```ts\r\n  x  =  1   \r\n```\r\n";
    const once = canonicalizeText(input);
    const twice = canonicalizeText(once);
    assert.equal(twice, once);
    assert.match(once, /```ts\n  x  =  1   \n```/);
    assert.ok(!once.includes("\r"));
});

test("assistant thinking and toolCall blocks are excluded; final text is retained", () => {
    const entries = [{
        type: "message",
        timestamp: "2026-01-01T00:00:00Z",
        message: {
            role: "assistant",
            content: [
                {type: "thinking", thinking: "private"},
                {type: "text", text: "visible"},
                {type: "toolCall", name: "read", arguments: {path: "/tmp/x"}},
            ],
        },
    }];
    const result = projectEntries(entries, "s1", DEFAULT_POLICY);
    assert.equal(result.length, 1);
    assert.equal(result[0].kind, "assistant");
    assert.equal(result[0].text, "visible");
});

test("tool results are omitted by default and can be included as errors", () => {
    const entries = [
        {type: "message", message: {role: "toolResult", content: [{type: "text", text: "all good"}]}},
        {type: "message", message: {role: "toolResult", isError: true, content: [{type: "text", text: "Error: boom"}]}},
    ];
    assert.equal(projectEntries(entries, "s1", DEFAULT_POLICY).length, 0);
    const errorPolicy = mergePolicy(DEFAULT_POLICY, {toolText: "errors"});
    const result = projectEntries(entries, "s1", errorPolicy);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, "Error: boom");
});

test("active-branch skips raw compaction summaries while effective-context keeps them", () => {
    const entries = [{type: "compaction", summary: "checkpoint"}];
    assert.equal(projectEntries(entries, "s1", mergePolicy(DEFAULT_POLICY, {sourceView: "active-branch"})).length, 0);
    const result = projectEntries(entries, "s1", mergePolicy(DEFAULT_POLICY, {sourceView: "effective-context"}));
    assert.equal(result.length, 1);
    assert.equal(result[0].kind, "checkpoint");
});

test("same exact text from different roles is never cross-role deduplicated", () => {
    const result = cleanupDocuments([doc("s1", [["user", "same"], ["assistant", "same"]])], mergePolicy(DEFAULT_POLICY, {secrets: "preserve-local-only"}));
    assert.equal(result.document.segments.length, 2);
    assert.deepEqual(result.document.segments.map((item) => item.kind), ["user", "assistant"]);
});

test("longest suffix-prefix overlap removes duplicated cross-session tail", () => {
    const a = doc("a", [["user", "A1"], ["assistant", "A2"], ["user", "A3"]], 0);
    const b = doc("b", [["assistant", "A2"], ["user", "A3"], ["assistant", "B1"]], 1);
    const result = cleanupDocuments([a, b], mergePolicy(DEFAULT_POLICY, {secrets: "preserve-local-only", mergeOrder: "given", dedup: {...DEFAULT_POLICY.dedup, near: "off"}}));
    assert.deepEqual(result.document.segments.map((item) => item.text), ["A1", "A2", "A3", "B1"]);
    assert.equal(result.diagnostics.overlapSegmentsRemoved, 2);
});

test("conservative lexical near-dedup only collapses near-copy across sessions", () => {
    const base = "这是一段用于测试跨会话复制的长文本，内容必须足够长，以避免短消息被误判。".repeat(4);
    const a = doc("a", [["assistant", base]], 0);
    const b = doc("b", [["assistant", `${base}！`]], 1);
    const result = cleanupDocuments([a, b], mergePolicy(DEFAULT_POLICY, {secrets: "preserve-local-only", mergeOrder: "given", dedup: {exact: true, overlap: true, near: "lexical"}}));
    assert.equal(result.document.segments.length, 1);
    assert.equal(result.diagnostics.nearDuplicatesRemoved, 1);
});

test("near-dedup never collapses code-fence revisions", () => {
    const a = doc("a", [["assistant", "```ts\nconst a = 1;\n```"]], 0);
    const b = doc("b", [["assistant", "```ts\nconst a = 2;\n```"]], 1);
    const result = cleanupDocuments([a, b], mergePolicy(DEFAULT_POLICY, {secrets: "preserve-local-only", mergeOrder: "given"}));
    assert.equal(result.document.segments.length, 2);
});

test("clean session hidden IR makes second cleanup byte-identical", () => {
    const first = cleanupDocuments([
        doc("raw", [["user", "需求"], ["assistant", "结果"]]),
    ], mergePolicy(DEFAULT_POLICY, {secrets: "preserve-local-only"}));
    const ir = storedIrFromResult(first);
    const branch = [
        {type: "custom_message", id: "body", parentId: null, customType: "cleanup_text", display: true, content: [{type: "text", text: first.text}]},
        {type: "custom", id: "ir", parentId: "body", customType: "cleanup_ir", data: ir},
    ];
    const read = documentFromEntries({
        sourceId: "clean1",
        sourceIndex: 0,
        branchEntries: branch,
        effectiveEntries: branch,
        policy: mergePolicy(DEFAULT_POLICY, {secrets: "preserve-local-only"}),
    });
    assert.equal(read.reusedCanonicalIr, true);
    const second = cleanupDocuments([read.document], mergePolicy(DEFAULT_POLICY, {secrets: "preserve-local-only"}), 1);
    assert.equal(second.text, first.text);
    assert.equal(second.outputContentHash, first.outputContentHash);
});

test("clean session plus new visible tail can be cleaned again without duplicating old body", () => {
    const policy = mergePolicy(DEFAULT_POLICY, {secrets: "preserve-local-only"});
    const first = cleanupDocuments([doc("raw", [["user", "旧问题"], ["assistant", "旧回答"]])], policy);
    const ir = storedIrFromResult(first);
    const branch = [
        {type: "custom_message", id: "body", parentId: null, customType: "cleanup_text", display: true, content: [{type: "text", text: first.text}]},
        {type: "custom", id: "ir", parentId: "body", customType: "cleanup_ir", data: ir},
        {type: "message", id: "new1", parentId: "ir", message: {role: "user", content: [{type: "text", text: "新问题"}]}},
        {type: "message", id: "new2", parentId: "new1", message: {role: "assistant", content: [{type: "text", text: "新回答"}]}},
    ];
    const read = documentFromEntries({sourceId: "clean1", sourceIndex: 0, branchEntries: branch, effectiveEntries: branch, policy});
    const second = cleanupDocuments([read.document], policy, 1);
    assert.equal(second.document.segments.length, 4);
    assert.equal(second.text.match(/旧问题/g)?.length, 1);
    assert.equal(second.text.match(/新问题/g)?.length, 1);
});

test("secret redaction is narrow and deterministic", () => {
    const input = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz\npassword=super-secret-value\nnormal=hello";
    const first = redactSecrets(input);
    const second = redactSecrets(first.text);
    assert.ok(first.count >= 2);
    assert.equal(second.text, first.text);
    assert.match(first.text, /normal=hello/);
    assert.match(first.text, /Authorization: Bearer \[REDACTED\]/);
    assert.doesNotMatch(first.text, /\$1 \[REDACTED\]/);
    assert.doesNotMatch(first.text, /super-secret-value/);
});

test("writer stores visible body once in context plus hidden manifest/IR, without compaction", () => {
    const policy = mergePolicy(DEFAULT_POLICY, {secrets: "preserve-local-only"});
    const result = cleanupDocuments([doc("raw", [["user", "hello"], ["assistant", "world"]])], policy);
    const manifest: TextualCleanupManifest = {
        schemaVersion: 3,
        cleanerVersion: "test",
        runId: "run",
        createdAt: "2026-01-01T00:00:00.000Z",
        mode: "textual",
        directSources: [{source: "pi", sourceId: "raw"}],
        sourceCount: 1,
        sourceView: policy.sourceView,
        policy,
        policyHash: result.policyHash,
        inputContentHash: result.inputContentHash,
        outputContentHash: result.outputContentHash,
        diagnostics: result.diagnostics,
    };
    const lines = buildCleanSessionLinesFromResult({sessionId: "clean-id", cwd: "/tmp", title: "clean", imports: [], manifest, result, timestamp: "2026-01-01T00:00:00.000Z"});
    verifyCleanSessionLines(lines, result.text, "clean-id");
    assert.equal(lines.filter((line) => line.type === "compaction").length, 0);
    assert.equal(lines.filter((line) => line.type === "custom_message" && line.customType === "cleanup_text").length, 1);
    assert.equal(lines.filter((line) => line.type === "custom" && line.customType === "cleanup_ir").length, 1);
});
