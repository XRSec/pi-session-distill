import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    atomicWrite0600,
    assertFactLedgerDomainsPreserved,
    capsuleReviewPasses,
    chunkWholeBlocks,
    collectImportSources,
    createSnapshot,
    groupMessageTransactions,
    preserveRetainedTail,
    remapFactLedgerSources,
    resolveSessionIds,
    sessionJsonl,
    sha256File,
    singleFactLedgerDomain,
    stripAssistantThinking,
    switchPreservingSources,
    validateCapsuleResponse,
    validateCapsuleReviewResponse,
    validateFactLedgerResponse,
    validateSessionHeaderLine,
} from "../core.ts";

const headings = [
    "## Current State", "## System Map", "## Decisions and Invariants", "## Lessons from Failures",
    "## Open Work", "## How to Resume", "## Evidence Boundaries",
];

function markdown(): string {
    return headings.map((heading) => `${heading}\n- None observed`).join("\n\n");
}

function preserved(sourcePath: string) {
    return {sourcePath, sha256: sha256File(sourcePath)};
}


test("长输入只在完整消息/工具结果块边界分组", () => {
    const blocks = ["message-a", "tool-result-that-is-larger-than-budget", "message-c"];
    const chunks = chunkWholeBlocks(blocks, 12);
    assert.deepEqual(chunks.flat(), blocks);
    assert.ok(chunks.every((chunk) => chunk.every((block) => blocks.includes(block))));
});

test("源会话 header ID 在打开前可 fail closed", () => {
    const line = JSON.stringify({type: "session", version: 3, id: "other", cwd: "/work"});
    assert.throws(() => validateSessionHeaderLine(line, "expected"), /header ID 不匹配/);
    assert.equal(validateSessionHeaderLine(line, "other"), 3);
});

test("stopReason length 被拒绝", () => {
    const raw = JSON.stringify({title: "title", domain: "test", markdown: markdown(), coveredSourceIds: ["source-1"]});
    assert.throws(() => validateCapsuleResponse(raw, "length", ["source-1"]), /未正常停止/);
});

test("事实账本要求原子事实、单主题 current 和实际来源覆盖", () => {
    const value = {
        domainCandidates: ["token-harbor"],
        facts: [{
            factId: "source-1:fact-1", subject: "account-count", domainId: "token-harbor",
            category: "state", statement: "当前有一个可验证状态", status: "current",
            confidence: "verified", asOf: "2026-01-01", sourceIds: ["source-1"], supersedesFactIds: [],
        }],
        coveredSourceIds: ["source-1"],
    };
    const ledger = validateFactLedgerResponse(JSON.stringify(value), "stop", ["source-1"]);
    assert.equal(singleFactLedgerDomain(ledger), "token-harbor");
    assert.deepEqual(remapFactLedgerSources(ledger, "root").facts[0].sourceIds, ["root"]);

    const missing = structuredClone(value);
    missing.coveredSourceIds.push("source-2");
    assert.throws(() => validateFactLedgerResponse(JSON.stringify(missing), "stop", ["source-1", "source-2"]), /facts 未实际覆盖/);

    const mixed = structuredClone(value);
    mixed.domainCandidates.push("grok-xai");
    mixed.facts.push({...mixed.facts[0], factId: "source-1:fact-2", subject: "oauth-state", domainId: "grok-xai", status: "historical"});
    const mixedLedger = validateFactLedgerResponse(JSON.stringify(mixed), "stop", ["source-1"]);
    assert.equal(singleFactLedgerDomain(mixedLedger), "grok-xai+token-harbor");
    assert.throws(() => assertFactLedgerDomainsPreserved([mixedLedger], ledger), /改写或丢失/);

    const orthogonal = structuredClone(value);
    orthogonal.facts.push({...orthogonal.facts[0], factId: "source-1:fact-2", category: "capability", statement: "同一主题下另一个正交能力仍然有效"});
    assert.doesNotThrow(() => validateFactLedgerResponse(JSON.stringify(orthogonal), "stop", ["source-1"]));

    const conflicting = structuredClone(value);
    conflicting.facts.push({...conflicting.facts[0], factId: "source-1:fact-2", statement: "同一可变状态的另一个 current 值"});
    assert.throws(() => validateFactLedgerResponse(JSON.stringify(conflicting), "stop", ["source-1"]), /多个 current/);

    const superseding = structuredClone(value);
    superseding.facts[0].supersedesFactIds = ["source-1:old"];
    superseding.facts.push({...superseding.facts[0], factId: "source-1:old", statement: "已被替代的旧状态", status: "superseded", supersedesFactIds: []});
    assert.doesNotThrow(() => validateFactLedgerResponse(JSON.stringify(superseding), "stop", ["source-1"]));
    superseding.facts[1].status = "historical";
    assert.throws(() => validateFactLedgerResponse(JSON.stringify(superseding), "stop", ["source-1"]), /语义无效/);
});

test("知识胶囊正文只保留精炼章节，来源追溯留在 manifest", () => {
    const raw = JSON.stringify({title: "title", domain: "token-harbor", markdown: markdown(), coveredSourceIds: ["source-1"]});
    const capsule = validateCapsuleResponse(raw, "stop", ["source-1"], "token-harbor");
    assert.equal(capsule.markdown.includes("source-1"), false);
    const auditBody = `${markdown()}\n\n## Source Coverage\n- source-1`;
    assert.throws(
        () => validateCapsuleResponse(JSON.stringify({title: "title", domain: "token-harbor", markdown: auditBody, coveredSourceIds: ["source-1"]}), "stop", ["source-1"], "token-harbor"),
        /二级章节|来源追溯细节/,
    );
    const leakedId = markdown().replace("- None observed", "- source-1");
    assert.throws(
        () => validateCapsuleResponse(JSON.stringify({title: "title", domain: "token-harbor", markdown: leakedId, coveredSourceIds: ["source-1"]}), "stop", ["source-1"], "token-harbor"),
        /来源追溯细节/,
    );
});

test("内容质量门禁要求六项评分、章节和事实证据一致", () => {
    const criteria = ["scopePurity", "currentState", "contradictionResolution", "actionability", "concision", "sourceFaithfulness"];
    const value = {
        pass: true,
        scores: {scopePurity: 5, currentState: 5, contradictionResolution: 4, actionability: 4, concision: 4, sourceFaithfulness: 5},
        evidence: criteria.map((criterion, index) => ({criterion, section: headings[index % headings.length], factIds: ["fact-1"]})),
        issues: [], rewriteInstructions: "",
    };
    assert.equal(capsuleReviewPasses(validateCapsuleReviewResponse(JSON.stringify(value), "stop", new Set(["fact-1"]), new Set(["fact-1"]))), true);
    const headingsWithoutPrefix = structuredClone(value);
    headingsWithoutPrefix.evidence = headingsWithoutPrefix.evidence.map((entry) => ({...entry, section: entry.section.replace(/^## /, "")}));
    assert.equal(validateCapsuleReviewResponse(JSON.stringify(headingsWithoutPrefix), "stop", new Set(["fact-1"])).evidence[0].section, headings[0]);
    assert.throws(
        () => validateCapsuleReviewResponse(JSON.stringify(value), "stop", new Set(["fact-1", "fact-2"]), new Set(["fact-2"])),
        /未覆盖关键 facts/,
    );
    const inconsistent = structuredClone(value);
    inconsistent.issues = ["仍有实质问题"];
    assert.throws(() => validateCapsuleReviewResponse(JSON.stringify(inconsistent), "stop", new Set(["fact-1"])), /不应包含问题/);

    const weak = structuredClone(value);
    weak.pass = false;
    weak.scores.concision = 3;
    weak.issues = ["重复内容"];
    weak.rewriteInstructions = "删除重复内容";
    assert.equal(capsuleReviewPasses(validateCapsuleReviewResponse(JSON.stringify(weak), "stop", new Set(["fact-1"]), new Set(["fact-1"]))), false);
});

test("assistant thinking 在 cleanup 序列化前被排除", () => {
    const message = {
        role: "assistant",
        content: [
            {type: "thinking", thinking: "临时推测"},
            {type: "text", text: "最终结论"},
            {type: "toolCall", id: "call-1", name: "read", arguments: {path: "file.txt"}},
        ],
    };
    assert.deepEqual(stripAssistantThinking(message), {
        ...message,
        content: message.content.slice(1),
    });
    assert.deepEqual(stripAssistantThinking({role: "user", content: "保留"}), {role: "user", content: "保留"});
});

test("compaction summary 和 retainedTail 都被保留", () => {
    const summary = {role: "compactionSummary", summary: "old summary", tokensBefore: 10};
    const tail = [
        {role: "user", content: "tail request", timestamp: 1},
        {role: "toolResult", toolName: "bash", content: [{type: "text", text: "tail output"}], isError: true, timestamp: 2},
    ];
    const entries = [{type: "compaction", summary: "old summary", retainedTail: tail}];
    assert.deepEqual(preserveRetainedTail([summary], entries), [summary, ...tail]);
    assert.deepEqual(preserveRetainedTail([summary, ...tail], entries), [summary, ...tail]);
});

test("工具调用与紧随的工具结果保持为一个事务块", () => {
    const messages = [
        {role: "user", content: "run"},
        {role: "assistant", content: [{type: "toolCall", id: "call-1", name: "bash", arguments: {command: "pwd"}}]},
        {role: "toolResult", toolCallId: "call-1", content: [{type: "text", text: "/tmp"}]},
        {role: "assistant", content: [{type: "text", text: "done"}]},
    ];
    const groups = groupMessageTransactions(messages);
    assert.deepEqual(groups.map((group) => group.length), [1, 2, 1]);
    assert.equal((groups[1][0] as {role: string}).role, "assistant");
    assert.equal((groups[1][1] as {role: string}).role, "toolResult");
});

test("直接与传递 import_source 去重且保持直接来源优先", () => {
    const imports = collectImportSources(
        [{source: "pi", sourceId: "direct"}],
        [[
            {type: "custom", customType: "import_source", data: {source: "pi", sourceId: "direct"}},
            {type: "custom", customType: "import_source", data: {source: "claude", sourceId: "ancestor"}},
            {type: "custom", customType: "import_source", data: {source: "claude", sourceId: "ancestor"}},
        ]],
    );
    assert.deepEqual(imports, [
        {source: "pi", sourceId: "direct"},
        {source: "claude", sourceId: "ancestor"},
    ]);
});

test("import_source 接受普通标识", () => {
    const imports = collectImportSources([{source: "pi", sourceId: "alice.private@example.test"}], []);
    assert.deepEqual(imports, [{source: "pi", sourceId: "alice.private@example.test"}]);
});


test("切换取消不会修改或删除源文件", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-cancel-"));
    try {
        const source = path.join(directory, "source.jsonl");
        fs.writeFileSync(source, "source bytes", {mode: 0o600});
        const before = fs.readFileSync(source);
        const result = await switchPreservingSources(path.join(directory, "capsule.jsonl"), [preserved(source)], async () => ({cancelled: true}));
        assert.equal(result.cancelled, true);
        assert.deepEqual(fs.readFileSync(source), before);
    } finally {
        fs.rmSync(directory, {recursive: true, force: true});
    }
});

test("切换取消后源发生变化只记录 warning，不覆盖 switch 结果", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-cancel-change-"));
    try {
        const source = path.join(directory, "source.jsonl");
        fs.writeFileSync(source, "before", {mode: 0o600});
        const warnings: string[] = [];
        const result = await switchPreservingSources(
            path.join(directory, "capsule.jsonl"),
            [preserved(source)],
            async () => {
                fs.writeFileSync(source, "after", {mode: 0o600});
                return {cancelled: true};
            },
            (message) => warnings.push(message),
        );
        assert.equal(result.cancelled, true);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /切换期间源会话发生变化/);
    } finally {
        fs.rmSync(directory, {recursive: true, force: true});
    }
});

test("源在进入切换前已变化时仅告警并继续切换", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-switch-before-"));
    try {
        const source = path.join(directory, "source.jsonl");
        fs.writeFileSync(source, "before", {mode: 0o600});
        const expected = preserved(source);
        fs.writeFileSync(source, "changed", {mode: 0o600});
        const warnings: string[] = [];
        let called = false;
        const result = await switchPreservingSources(
            path.join(directory, "capsule.jsonl"),
            [expected],
            async () => {
                called = true;
                return {cancelled: false};
            },
            (message) => warnings.push(message),
        );
        assert.equal(result.cancelled, false);
        assert.equal(called, true);
        assert.ok(warnings.some((message) => /切换前源会话发生变化/.test(message)));
    } finally {
        fs.rmSync(directory, {recursive: true, force: true});
    }
});

test("切换器抛错时保留原始 switch 错误，同时记录源变化 warning", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-switch-error-"));
    try {
        const source = path.join(directory, "source.jsonl");
        fs.writeFileSync(source, "before", {mode: 0o600});
        const warnings: string[] = [];
        await assert.rejects(
            switchPreservingSources(
                path.join(directory, "capsule.jsonl"),
                [preserved(source)],
                async () => {
                    fs.writeFileSync(source, "changed", {mode: 0o600});
                    throw new Error("switch failed");
                },
                (message) => warnings.push(message),
            ),
            /switch failed/,
        );
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /切换期间源会话发生变化/);
    } finally {
        fs.rmSync(directory, {recursive: true, force: true});
    }
});

test("切换期间同内容 inode 替换不阻断，因为文本快照内容未变化", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-switch-inode-"));
    try {
        const source = path.join(directory, "source.jsonl");
        fs.writeFileSync(source, "same bytes", {mode: 0o600});
        const warnings: string[] = [];
        const result = await switchPreservingSources(
            path.join(directory, "capsule.jsonl"),
            [preserved(source)],
            async () => {
                const replacement = path.join(directory, "replacement.jsonl");
                fs.writeFileSync(replacement, "same bytes", {mode: 0o600});
                fs.renameSync(replacement, source);
                return {cancelled: false};
            },
            (message) => warnings.push(message),
        );
        assert.equal(result.cancelled, false);
        assert.deepEqual(warnings, []);
    } finally {
        fs.rmSync(directory, {recursive: true, force: true});
    }
});

test("歧义 ID 前缀 fail closed", () => {
    const all = [
        {path: "/tmp/a", id: "abc111", cwd: "/work"},
        {path: "/tmp/b", id: "abc222", cwd: "/work"},
    ];
    assert.throws(() => resolveSessionIds(all, ["abc"], "/work", "current"), /歧义/);
});

test("原子产物为 0600，快照目录为 0700 且文件为 0600", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-mode-"));
    try {
        const source = path.join(directory, "source.jsonl");
        fs.writeFileSync(source, "fixture", {mode: 0o600});
        const output = path.join(directory, "output.jsonl");
        atomicWrite0600(output, "output");
        assert.equal(fs.statSync(output).mode & 0o777, 0o600);
        assert.throws(
            () => atomicWrite0600(output, "replacement"),
            (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST",
        );
        assert.equal(fs.readFileSync(output, "utf8"), "output");

        const snapshot = createSnapshot([source], path.join(directory, "backups"), "run-id");
        assert.equal(fs.statSync(snapshot.directory).mode & 0o777, 0o700);
        assert.equal(fs.statSync(path.join(snapshot.directory, snapshot.files[0].file)).mode & 0o777, 0o600);
        assert.equal(fs.statSync(path.join(snapshot.directory, "manifest.json")).mode & 0o777, 0o600);
        assert.match(snapshot.files[0].sha256, /^[a-f0-9]{64}$/);
    } finally {
        fs.rmSync(directory, {recursive: true, force: true});
    }
});
