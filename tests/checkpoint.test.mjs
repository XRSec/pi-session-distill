import assert from "node:assert/strict";
import {chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "session-distill-checkpoint-test-"));
process.env.SESSION_DISTILL_CHECKPOINT_ROOT = root;
const {openCleanupCheckpoint} = await import("../checkpoint.ts");

test("checkpoint 按来源、模型、prompt 和输入哈希复用", () => {
    try {
        const identity = {
            sourceSnapshots: [{sourceId: "source-a", sha256: "abc", bytes: 123}],
            model: "openai-codex/gpt-5.6-luna",
            promptVersion: "handoff-test-v1",
        };
        const first = openCleanupCheckpoint(identity);
        first.write("fragment-a", "input-hash", {coverageId: "a", facts: [1]});
        assert.equal(statSync(first.directory).mode & 0o777, 0o700);
        const artifactPath = join(first.directory, readdirSync(first.directory).find((name) => name.startsWith("fragment-a-")));
        assert.equal(statSync(artifactPath).mode & 0o777, 0o600);

        const second = openCleanupCheckpoint(identity);
        assert.equal(second.key, first.key);
        assert.deepEqual(second.read("fragment-a", "input-hash", (value) => value), {coverageId: "a", facts: [1]});
        assert.equal(second.read("fragment-a", "different-input", (value) => value), undefined);

        const changedSource = openCleanupCheckpoint({
            ...identity, sourceSnapshots: [{sourceId: "source-a", sha256: "def", bytes: 456}]
        });
        assert.notEqual(changedSource.key, first.key);
        assert.deepEqual(changedSource.read("fragment-a", "input-hash", (value) => value), {
            coverageId: "a", facts: [1]
        });
        changedSource.remove();

        writeFileSync(artifactPath, "not json");
        chmodSync(artifactPath, 0o600);
        assert.equal(second.read("fragment-a", "input-hash", (value) => value), undefined);
        second.remove();
        assert.equal(existsSync(second.directory), false);
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});
