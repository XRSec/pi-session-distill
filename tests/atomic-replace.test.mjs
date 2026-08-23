import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, rmSync, statSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {atomicReplace0600, atomicWrite0600} from "../core.ts";

test("atomicReplace0600 原子覆盖已有 0600 manifest", () => {
    const directory = mkdtempSync(join(tmpdir(), "session-cleanup-atomic-replace-"));
    try {
        const manifest = join(directory, "manifest.json");
        atomicWrite0600(manifest, "pending\n");
        atomicReplace0600(manifest, "moved\n");
        assert.equal(readFileSync(manifest, "utf8"), "moved\n");
        assert.equal(statSync(manifest).mode & 0o777, 0o600);
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
});
