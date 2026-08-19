import * as fs from "node:fs";
import {documentFromEntries, type CleanupPolicy, type CleanDocument} from "./textual.ts";

export interface ParsedPiSession {
    header: Record<string, unknown>;
    entries: Array<Record<string, unknown>>;
    branch: Array<Record<string, unknown>>;
    effectiveEntries: Array<Record<string, unknown>>;
}

export function parsePiJsonl(text: string): ParsedPiSession {
    const lines = text.split("\n").filter((line) => line.trim());
    if (lines.length === 0) throw new Error("空 JSONL");
    const records = lines.map((line, index) => {
        try { return JSON.parse(line) as Record<string, unknown>; }
        catch { throw new Error(`第 ${index + 1} 行不是有效 JSON`); }
    });
    const header = records[0];
    if (header.type !== "session") throw new Error("第一条记录不是 session header");
    const entries = records.slice(1).filter((record) => typeof record.id === "string");
    const branch = buildActiveBranch(entries);
    const effectiveEntries = buildEffectiveEntries(branch);
    return {header, entries, branch, effectiveEntries};
}

export function readPiJsonl(filePath: string): ParsedPiSession {
    return parsePiJsonl(fs.readFileSync(filePath, "utf8"));
}

export function buildActiveBranch(entries: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    if (entries.length === 0) return [];
    const byId = new Map(entries.filter((entry) => typeof entry.id === "string").map((entry) => [entry.id as string, entry]));
    let current = entries.at(-1);
    const reverse: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    while (current && typeof current.id === "string") {
        if (seen.has(current.id)) throw new Error(`父链存在环: ${current.id}`);
        seen.add(current.id);
        reverse.push(current);
        const parentId = current.parentId;
        if (parentId === null || parentId === undefined) break;
        if (typeof parentId !== "string") throw new Error(`parentId 无效: ${current.id}`);
        current = byId.get(parentId);
        if (!current) throw new Error(`父链缺失: ${parentId}`);
    }
    return reverse.reverse();
}

export function buildEffectiveEntries(branch: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    let latest: Record<string, unknown> | undefined;
    for (const entry of branch) if (entry.type === "compaction") latest = entry;
    if (!latest) return branch;
    const compactionIndex = branch.indexOf(latest);
    const context: Array<Record<string, unknown>> = [latest];
    const firstKept = typeof latest.firstKeptEntryId === "string" ? latest.firstKeptEntryId : undefined;
    if (firstKept) {
        let found = false;
        for (let index = 0; index < compactionIndex; index++) {
            const entry = branch[index];
            if (entry.id === firstKept) found = true;
            if (found) context.push(entry);
        }
    }
    context.push(...branch.slice(compactionIndex + 1));
    return context;
}

export function standaloneDocument(filePath: string, policy: CleanupPolicy, sourceIndex = 0): CleanDocument {
    const parsed = readPiJsonl(filePath);
    const sourceId = typeof parsed.header.id === "string" ? parsed.header.id : `source-${sourceIndex}`;
    return documentFromEntries({
        sourceId,
        sourcePath: filePath,
        sourceIndex,
        header: parsed.header,
        branchEntries: parsed.branch,
        effectiveEntries: parsed.effectiveEntries,
        policy,
    }).document;
}
