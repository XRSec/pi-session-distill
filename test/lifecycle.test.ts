import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {fileURLToPath} from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "..", "index.ts"), "utf8");

test("successful switch uses withSession replacement ctx and never reuses stale command ctx", () => {
    const start = source.indexOf("async function finalizeAndSwitch");
    const end = source.indexOf("async function runTextualCleanup", start);
    assert.ok(start >= 0 && end > start, "finalizeAndSwitch source not found");
    const fn = source.slice(start, end);

    assert.match(fn, /options\.ctx\.switchSession\(filePath,\s*\{/);
    assert.match(fn, /withSession:\s*async\s*\(replacementCtx\)/);
    assert.match(fn, /replacementCtx\.ui\.notify\(/);

    const successMarker = fn.indexOf("// Successful replacement invalidates the captured command context");
    assert.ok(successMarker >= 0, "success boundary marker missing");
    const successTail = fn.slice(successMarker);
    assert.doesNotMatch(successTail, /options\.ctx\./, "stale command ctx is referenced after successful replacement");
});
