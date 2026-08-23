import * as path from "node:path";
import {cleanupDocuments, DEFAULT_POLICY, mergePolicy, type SourceView} from "../textual.ts";
import {standaloneDocument} from "../standalone.ts";

const args = process.argv.slice(2);
let view: SourceView = DEFAULT_POLICY.sourceView;
const files: string[] = [];
for (let index = 0; index < args.length; index++) {
    if (args[index] === "--view") {
        const next = args[++index];
        if (next !== "active-branch" && next !== "effective-context") throw new Error("--view 仅支持 active-branch|effective-context");
        view = next;
    } else {
        files.push(path.resolve(args[index]));
    }
}
if (files.length === 0) {
    console.error("用法: node --experimental-strip-types scripts/analyze-session.ts [--view active-branch|effective-context] a.jsonl [b.jsonl ...]");
    process.exit(2);
}
const policy = mergePolicy(DEFAULT_POLICY, {sourceView: view});
const docs = files.map((file, index) => standaloneDocument(file, policy, index));
const result = cleanupDocuments(docs, policy, 0);
console.log(JSON.stringify({
    view,
    sources: files.map((file, index) => ({file, visibleSegments: docs[index].segments.length})),
    outputSegments: result.document.segments.length,
    outputChars: result.text.length,
    inputContentHash: result.inputContentHash,
    outputContentHash: result.outputContentHash,
    diagnostics: result.diagnostics,
}, null, 2));
