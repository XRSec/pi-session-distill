import * as crypto from "node:crypto";

export type SourceView = "effective-context" | "active-branch";
export type VisibleKind = "user" | "assistant" | "tool" | "checkpoint" | "break";
export type Fidelity = "verbatim" | "derived";
export type ToolTextPolicy = "none" | "errors" | "all";
export type NearDedupPolicy = "off" | "lexical";
export type MergeOrderPolicy = "auto" | "given";

export interface VisibleSegment {
    kind: VisibleKind;
    text: string;
    sourceOrder: number;
    occurredAt?: number;
    incomplete?: boolean;
    fidelity: Fidelity;
    sourceId?: string;
}

export interface CleanupPolicy {
    mode: "textual" | "semantic";
    sourceView: SourceView;
    roleLabels: "keep" | "strip";
    timestamps: "strip" | "inline";
    toolText: ToolTextPolicy;
    bashText: ToolTextPolicy;
    nonText: "drop" | "placeholder";
    dedup: {
        exact: boolean;
        overlap: boolean;
        near: NearDedupPolicy;
    };
    secrets: "redact" | "preserve-local-only";
    breakpointMarker: "none" | "visible";
    mergeOrder: MergeOrderPolicy;
}

export const DEFAULT_POLICY: CleanupPolicy = {
    mode: "textual",
    sourceView: "active-branch",
    roleLabels: "keep",
    timestamps: "strip",
    toolText: "none",
    bashText: "none",
    nonText: "drop",
    dedup: {
        exact: true,
        overlap: true,
        near: "lexical",
    },
    secrets: "redact",
    breakpointMarker: "none",
    mergeOrder: "auto",
};

export interface CleanDocument {
    schema: "clean-text/v1";
    sourceId: string;
    sourcePath?: string;
    parentSession?: string;
    createdAt?: number;
    sourceIndex: number;
    segments: VisibleSegment[];
}

export interface CleanupDiagnostics {
    inputDocuments: number;
    inputSegments: number;
    outputSegments: number;
    exactDuplicatesRemoved: number;
    overlapSegmentsRemoved: number;
    nearDuplicatesRemoved: number;
    redactionsApplied: number;
    reusedCanonicalIr: number;
}

export interface CleanupResult {
    document: CleanDocument;
    text: string;
    inputContentHash: string;
    outputContentHash: string;
    policyHash: string;
    diagnostics: CleanupDiagnostics;
}

export interface StoredCleanIr {
    schemaVersion: 1;
    body: string;
    outputContentHash: string;
    policyHash: string;
    segments: Array<Pick<VisibleSegment, "kind" | "text" | "sourceOrder" | "occurredAt" | "incomplete" | "fidelity" | "sourceId">>;
}

interface EntryLike {
    type?: unknown;
    id?: unknown;
    parentId?: unknown;
    timestamp?: unknown;
    message?: unknown;
    summary?: unknown;
    customType?: unknown;
    content?: unknown;
    display?: unknown;
    data?: unknown;
    name?: unknown;
}

interface HeaderLike {
    type?: unknown;
    id?: unknown;
    timestamp?: unknown;
    cwd?: unknown;
    parentSession?: unknown;
}

function clonePolicy(policy: CleanupPolicy): CleanupPolicy {
    return {
        ...policy,
        dedup: {...policy.dedup},
    };
}

export function mergePolicy(base: CleanupPolicy = DEFAULT_POLICY, patch: Partial<CleanupPolicy> = {}): CleanupPolicy {
    const merged = clonePolicy(base);
    Object.assign(merged, patch);
    if (patch.dedup) merged.dedup = {...base.dedup, ...patch.dedup};
    return merged;
}

export function sha256Text(text: string): string {
    return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function canonicalObject(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalObject);
    if (!value || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, canonicalObject(object[key])]));
}

export function cleanupPolicyHash(policy: CleanupPolicy): string {
    return sha256Text(JSON.stringify(canonicalObject(policy)));
}

function inFenceToggle(line: string, current: {marker?: string}): void {
    const match = line.match(/^\s*(```+|~~~+)/);
    if (!match) return;
    const marker = match[1][0];
    if (!current.marker) current.marker = marker;
    else if (current.marker === marker) current.marker = undefined;
}

/** Conservative, idempotent text normalization. Code-fence bodies are never reflowed. */
export function canonicalizeText(input: string): string {
    const normalized = input.replace(/\r\n?/g, "\n").normalize("NFC");
    const lines = normalized.split("\n");
    const fence: {marker?: string} = {};
    const out: string[] = [];
    let blankRun = 0;

    for (const original of lines) {
        const wasInFence = Boolean(fence.marker);
        let line = original;
        if (!wasInFence) {
            // Preserve Markdown hard-break semantics (two trailing spaces), but remove tabs
            // and excessive trailing whitespace outside code fences.
            line = line.replace(/\t+$/g, "");
            line = line.replace(/ {3,}$/g, "  ");
        }

        const blank = line.length === 0;
        if (!wasInFence && blank) {
            blankRun += 1;
            if (blankRun > 2) continue;
        } else {
            blankRun = 0;
        }
        out.push(line);
        inFenceToggle(line, fence);
    }

    while (out.length > 0 && out[0] === "") out.shift();
    while (out.length > 0 && out.at(-1) === "") out.pop();
    return out.join("\n");
}

function looksLikeCode(text: string): boolean {
    return /(^|\n)\s*(```|~~~)/.test(text);
}

function normalizeForFingerprint(text: string): string {
    return canonicalizeText(text).replace(/[\t ]+/g, " ").replace(/\n{2,}/g, "\n").trim();
}

function segmentSignature(segment: VisibleSegment): string {
    return `${segment.kind}\0${sha256Text(normalizeForFingerprint(segment.text))}`;
}

function safeTime(value: unknown): number | undefined {
    if (typeof value !== "string" || !value) return undefined;
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : undefined;
}

function extractTextBlocks(content: unknown): string[] {
    if (typeof content === "string") return content ? [content] : [];
    if (!Array.isArray(content)) return [];
    const result: string[] = [];
    for (const part of content) {
        if (typeof part === "string") {
            if (part) result.push(part);
            continue;
        }
        if (!part || typeof part !== "object") continue;
        const block = part as Record<string, unknown>;
        if (block.type === "text" && typeof block.text === "string" && block.text) result.push(block.text);
    }
    return result;
}

function extractMessage(entry: EntryLike): Record<string, unknown> | undefined {
    if (!entry.message || typeof entry.message !== "object" || Array.isArray(entry.message)) return undefined;
    return entry.message as Record<string, unknown>;
}

function messageIsError(message: Record<string, unknown>): boolean {
    if (message.isError === true || message.error === true) return true;
    if (typeof message.errorMessage === "string" && message.errorMessage.trim()) return true;
    const text = extractTextBlocks(message.content).join("\n");
    return /(?:^|\n)\s*(?:error|failed|failure|exception|traceback)\b/i.test(text);
}

function bashText(message: Record<string, unknown>): string {
    const command = typeof message.command === "string" ? message.command : "";
    const output = typeof message.output === "string" ? message.output : extractTextBlocks(message.content).join("\n");
    if (!command) return output;
    if (!output) return `$ ${command}`;
    return `$ ${command}\n${output}`;
}

function segment(kind: VisibleKind, text: string, sourceOrder: number, sourceId: string, entry: EntryLike, fidelity: Fidelity = "verbatim", incomplete = false): VisibleSegment[] {
    if (!text) return [];
    return [{
        kind,
        text,
        sourceOrder,
        occurredAt: safeTime(entry.timestamp),
        incomplete: incomplete || undefined,
        fidelity,
        sourceId,
    }];
}

function projectMessageEntry(entry: EntryLike, sourceOrder: number, sourceId: string, policy: CleanupPolicy): VisibleSegment[] {
    const message = extractMessage(entry);
    if (!message) return [];
    const role = typeof message.role === "string" ? message.role : "";

    if (role === "user") {
        return extractTextBlocks(message.content).flatMap((text) => segment("user", text, sourceOrder, sourceId, entry));
    }
    if (role === "assistant") {
        const stopReason = typeof message.stopReason === "string" ? message.stopReason : "";
        const incomplete = stopReason === "length" || stopReason === "aborted" || stopReason === "abort";
        return extractTextBlocks(message.content).flatMap((text) => segment("assistant", text, sourceOrder, sourceId, entry, "verbatim", incomplete));
    }
    if (role === "toolResult") {
        if (policy.toolText === "none") return [];
        if (policy.toolText === "errors" && !messageIsError(message)) return [];
        return extractTextBlocks(message.content).flatMap((text) => segment("tool", text, sourceOrder, sourceId, entry));
    }
    if (role === "bashExecution") {
        if (policy.bashText === "none") return [];
        const exitCode = typeof message.exitCode === "number" ? message.exitCode : undefined;
        const failed = exitCode !== undefined ? exitCode !== 0 : messageIsError(message);
        if (policy.bashText === "errors" && !failed) return [];
        return segment("tool", bashText(message), sourceOrder, sourceId, entry);
    }
    if (role === "branchSummary") {
        const summary = typeof message.summary === "string" ? message.summary : extractTextBlocks(message.content).join("\n");
        return segment("checkpoint", summary, sourceOrder, sourceId, entry, "derived");
    }
    if (role === "compactionSummary") {
        const summary = typeof message.summary === "string" ? message.summary : extractTextBlocks(message.content).join("\n");
        return segment("checkpoint", summary, sourceOrder, sourceId, entry, "derived");
    }
    if (role === "custom") {
        return extractTextBlocks(message.content).flatMap((text) => segment("checkpoint", text, sourceOrder, sourceId, entry, "derived"));
    }
    return [];
}

export function projectEntries(entries: readonly unknown[], sourceId: string, policy: CleanupPolicy, startOrder = 0): VisibleSegment[] {
    const out: VisibleSegment[] = [];
    for (const [index, raw] of entries.entries()) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const entry = raw as EntryLike;
        const order = startOrder + index;
        if (entry.type === "message") {
            out.push(...projectMessageEntry(entry, order, sourceId, policy));
            continue;
        }
        if (entry.type === "custom_message") {
            // cleanup_text is handled through cleanup_ir when available. If not, keep it as a checkpoint.
            if (entry.customType === "cleanup_text" && entry.display === false) continue;
            const texts = extractTextBlocks(entry.content);
            out.push(...texts.flatMap((text) => segment("checkpoint", text, order, sourceId, entry, "derived")));
            continue;
        }
        if (entry.type === "branch_summary" && typeof entry.summary === "string") {
            out.push(...segment("checkpoint", entry.summary, order, sourceId, entry, "derived"));
            continue;
        }
        if (entry.type === "compaction" && policy.sourceView === "effective-context" && typeof entry.summary === "string") {
            out.push(...segment("checkpoint", entry.summary, order, sourceId, entry, "derived"));
        }
    }
    return out;
}

function readStoredIr(entry: EntryLike): StoredCleanIr | undefined {
    if (entry.type !== "custom" || entry.customType !== "cleanup_ir") return undefined;
    if (!entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)) return undefined;
    const data = entry.data as Record<string, unknown>;
    if (data.schemaVersion !== 1 || typeof data.body !== "string" || typeof data.outputContentHash !== "string" || typeof data.policyHash !== "string" || !Array.isArray(data.segments)) return undefined;
    const segments: StoredCleanIr["segments"] = [];
    for (const raw of data.segments) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
        const item = raw as Record<string, unknown>;
        if (!(["user", "assistant", "tool", "checkpoint", "break"] as string[]).includes(String(item.kind)) || typeof item.text !== "string") return undefined;
        segments.push({
            kind: item.kind as VisibleKind,
            text: item.text,
            sourceOrder: typeof item.sourceOrder === "number" ? item.sourceOrder : segments.length,
            occurredAt: typeof item.occurredAt === "number" ? item.occurredAt : undefined,
            incomplete: item.incomplete === true || undefined,
            fidelity: item.fidelity === "derived" ? "derived" : "verbatim",
            sourceId: typeof item.sourceId === "string" ? item.sourceId : undefined,
        });
    }
    return {
        schemaVersion: 1,
        body: data.body,
        outputContentHash: data.outputContentHash,
        policyHash: data.policyHash,
        segments,
    };
}

function latestStoredIr(branchEntries: readonly unknown[]): {index: number; ir: StoredCleanIr} | undefined {
    for (let index = branchEntries.length - 1; index >= 0; index--) {
        const raw = branchEntries[index];
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const ir = readStoredIr(raw as EntryLike);
        if (ir) return {index, ir};
    }
    return undefined;
}

function cleanIrToSegments(ir: StoredCleanIr, sourceId: string): VisibleSegment[] {
    return ir.segments.map((item, index) => ({
        ...item,
        sourceOrder: index,
        sourceId: item.sourceId || sourceId,
    }));
}

function hasCompactionAfter(entries: readonly unknown[], index: number): boolean {
    return entries.slice(index + 1).some((raw) => Boolean(raw && typeof raw === "object" && !Array.isArray(raw) && (raw as EntryLike).type === "compaction"));
}

export interface DocumentFromEntriesOptions {
    sourceId: string;
    sourcePath?: string;
    sourceIndex: number;
    header?: unknown;
    branchEntries: readonly unknown[];
    effectiveEntries: readonly unknown[];
    policy: CleanupPolicy;
}

export function documentFromEntries(options: DocumentFromEntriesOptions): {document: CleanDocument; reusedCanonicalIr: boolean} {
    const header = options.header && typeof options.header === "object" && !Array.isArray(options.header) ? options.header as HeaderLike : undefined;
    const stored = latestStoredIr(options.branchEntries);
    let segments: VisibleSegment[];
    let reusedCanonicalIr = false;

    if (stored && !hasCompactionAfter(options.branchEntries, stored.index)) {
        // A clean session is a first-class input. Reuse its hidden canonical IR, then append only
        // the new tail created after cleanup_ir. This is what makes second cleanup deterministic.
        const base = cleanIrToSegments(stored.ir, options.sourceId);
        const tail = options.branchEntries.slice(stored.index + 1);
        const tailSegments = projectEntries(tail, options.sourceId, {...options.policy, sourceView: "active-branch"}, base.length);
        segments = [...base, ...tailSegments];
        reusedCanonicalIr = true;
    } else {
        const chosen = options.policy.sourceView === "effective-context" ? options.effectiveEntries : options.branchEntries;
        segments = projectEntries(chosen, options.sourceId, options.policy, 0);
    }

    return {
        document: {
            schema: "clean-text/v1",
            sourceId: options.sourceId,
            sourcePath: options.sourcePath,
            parentSession: typeof header?.parentSession === "string" ? header.parentSession : undefined,
            createdAt: safeTime(header?.timestamp),
            sourceIndex: options.sourceIndex,
            segments,
        },
        reusedCanonicalIr,
    };
}

interface RedactResult {text: string; count: number}

/** Security-focused redaction. It intentionally avoids broad numeric/email regexes. */
export function redactSecrets(text: string): RedactResult {
    let count = 0;
    const replace = (pattern: RegExp, replacement: string | ((substring: string, ...args: string[]) => string)) => {
        if (typeof replacement === "string") {
            const matches = text.match(pattern);
            count += matches?.length ?? 0;
            text = text.replace(pattern, replacement);
            return;
        }
        text = text.replace(pattern, (...args: unknown[]) => {
            count += 1;
            return replacement(String(args[0]), ...(args.slice(1, -2).map(String)));
        });
    };

    replace(/\b(Bearer)\s+[A-Za-z0-9._~+\/-]{12,}/gi, "$1 [REDACTED]");
    replace(/\b(Basic)\s+[A-Za-z0-9+/=]{12,}/gi, "$1 [REDACTED]");
    replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_JWT]");
    replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_KEY]");
    replace(/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|auth[_-]?token)\s*[:=]\s*)["']?[^\s,"'}]{8,}["']?/gi,
        (_all, prefix) => `${prefix}[REDACTED]`);
    replace(/\b(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, (_all, scheme) => `${scheme}[REDACTED]@`);
    replace(/\b(postgres(?:ql)?|mysql|mongodb):\/\/([^\s/@:]+):([^\s/@]+)@/gi, (_all, scheme) => `${scheme}://[REDACTED]@`);
    return {text, count};
}

function normalizeSegment(segmentValue: VisibleSegment, policy: CleanupPolicy, diagnostics: CleanupDiagnostics): VisibleSegment | undefined {
    let text = canonicalizeText(segmentValue.text);
    if (!text) return undefined;
    if (policy.secrets === "redact") {
        const redacted = redactSecrets(text);
        text = redacted.text;
        diagnostics.redactionsApplied += redacted.count;
    }
    return {...segmentValue, text};
}

function removeAdjacentExact(segments: VisibleSegment[], diagnostics: CleanupDiagnostics): VisibleSegment[] {
    const out: VisibleSegment[] = [];
    for (const item of segments) {
        const previous = out.at(-1);
        if (previous && segmentSignature(previous) === segmentSignature(item)) {
            diagnostics.exactDuplicatesRemoved += 1;
            continue;
        }
        out.push(item);
    }
    return out;
}

function documentSignature(document: CleanDocument): string {
    return sha256Text(document.segments.map(segmentSignature).join("\n"));
}

function orderDocuments(documents: CleanDocument[], policy: CleanupPolicy): CleanDocument[] {
    if (policy.mergeOrder === "given" || documents.length < 2) return [...documents].sort((a, b) => a.sourceIndex - b.sourceIndex);

    const byPath = new Map(documents.filter((doc) => doc.sourcePath).map((doc) => [doc.sourcePath!, doc]));
    const children = new Map<CleanDocument, CleanDocument[]>();
    const indegree = new Map<CleanDocument, number>(documents.map((doc) => [doc, 0]));
    for (const doc of documents) {
        if (!doc.parentSession) continue;
        const parent = byPath.get(doc.parentSession);
        if (!parent || parent === doc) continue;
        const list = children.get(parent) ?? [];
        list.push(doc);
        children.set(parent, list);
        indegree.set(doc, (indegree.get(doc) ?? 0) + 1);
    }

    const compare = (a: CleanDocument, b: CleanDocument) => {
        const at = a.createdAt ?? Number.POSITIVE_INFINITY;
        const bt = b.createdAt ?? Number.POSITIVE_INFINITY;
        if (at !== bt) return at - bt;
        return a.sourceIndex - b.sourceIndex;
    };
    const ready = documents.filter((doc) => (indegree.get(doc) ?? 0) === 0).sort(compare);
    const out: CleanDocument[] = [];
    while (ready.length > 0) {
        const next = ready.shift()!;
        out.push(next);
        for (const child of (children.get(next) ?? []).sort(compare)) {
            indegree.set(child, (indegree.get(child) ?? 1) - 1);
            if ((indegree.get(child) ?? 0) === 0) {
                ready.push(child);
                ready.sort(compare);
            }
        }
    }
    if (out.length !== documents.length) return [...documents].sort(compare);
    return out;
}

function longestSuffixPrefix(left: VisibleSegment[], right: VisibleSegment[]): number {
    const max = Math.min(left.length, right.length);
    const leftSignatures = left.map(segmentSignature);
    const rightSignatures = right.map(segmentSignature);
    outer: for (let count = max; count >= 1; count--) {
        const start = leftSignatures.length - count;
        for (let index = 0; index < count; index++) {
            if (leftSignatures[start + index] !== rightSignatures[index]) continue outer;
        }
        return count;
    }
    return 0;
}

function lexicalKey(text: string): string {
    return canonicalizeText(text)
        .toLowerCase()
        .replace(/[\p{P}\p{S}\s]+/gu, "")
        .trim();
}

function conservativeNearDuplicate(a: VisibleSegment, b: VisibleSegment): boolean {
    if (a.kind !== b.kind || a.sourceId === b.sourceId) return false;
    if (looksLikeCode(a.text) || looksLikeCode(b.text)) return false;
    if (Math.min(a.text.length, b.text.length) < 80) return false;
    const ak = lexicalKey(a.text);
    const bk = lexicalKey(b.text);
    if (!ak || !bk) return false;
    // Only collapse extremely conservative cross-session copy/quote overlap: one normalized
    // string must almost contain the other. This is not free-form semantic deduplication.
    const shorter = ak.length <= bk.length ? ak : bk;
    const longer = ak.length > bk.length ? ak : bk;
    if (!longer.includes(shorter)) return false;
    return shorter.length / longer.length >= 0.98;
}

function removeBoundaryNearDuplicates(segments: VisibleSegment[], diagnostics: CleanupDiagnostics): VisibleSegment[] {
    const out: VisibleSegment[] = [];
    for (const item of segments) {
        const previous = out.at(-1);
        if (previous && conservativeNearDuplicate(previous, item)) {
            diagnostics.nearDuplicatesRemoved += 1;
            if (item.text.length > previous.text.length) out[out.length - 1] = item;
            continue;
        }
        out.push(item);
    }
    return out;
}

function segmentLabel(kind: VisibleKind): string {
    switch (kind) {
        case "user": return "用户";
        case "assistant": return "助手";
        case "tool": return "工具";
        case "checkpoint": return "上下文";
        case "break": return "断点";
    }
}

function isoIfValid(milliseconds?: number): string | undefined {
    if (milliseconds === undefined || !Number.isFinite(milliseconds)) return undefined;
    try { return new Date(milliseconds).toISOString(); } catch { return undefined; }
}

export function renderCanonical(document: CleanDocument, policy: CleanupPolicy): string {
    const chunks: string[] = [];
    for (const item of document.segments) {
        const text = canonicalizeText(item.text);
        if (!text) continue;
        if (item.kind === "break" && policy.breakpointMarker === "none") continue;
        const timestamp = policy.timestamps === "inline" ? isoIfValid(item.occurredAt) : undefined;
        if (policy.roleLabels === "strip") {
            chunks.push(timestamp ? `[${timestamp}]\n${text}` : text);
            continue;
        }
        const label = segmentLabel(item.kind);
        chunks.push(`${label}${timestamp ? ` [${timestamp}]` : ""}：\n${text}`);
    }
    return chunks.length > 0 ? `${chunks.join("\n\n")}\n` : "";
}

export function hashDocuments(documents: readonly CleanDocument[]): string {
    const canonical = documents.map((doc) => ({
        sourceId: doc.sourceId,
        parentSession: doc.parentSession,
        createdAt: doc.createdAt,
        segments: doc.segments.map((item) => ({kind: item.kind, text: canonicalizeText(item.text), incomplete: Boolean(item.incomplete), fidelity: item.fidelity})),
    }));
    return sha256Text(JSON.stringify(canonicalObject(canonical)));
}

export function cleanupDocuments(documents: readonly CleanDocument[], policyInput: CleanupPolicy = DEFAULT_POLICY, reusedCanonicalIr = 0): CleanupResult {
    const policy = mergePolicy(DEFAULT_POLICY, policyInput);
    const diagnostics: CleanupDiagnostics = {
        inputDocuments: documents.length,
        inputSegments: documents.reduce((sum, doc) => sum + doc.segments.length, 0),
        outputSegments: 0,
        exactDuplicatesRemoved: 0,
        overlapSegmentsRemoved: 0,
        nearDuplicatesRemoved: 0,
        redactionsApplied: 0,
        reusedCanonicalIr,
    };

    const normalizedDocuments = documents.map((doc) => {
        let segments = doc.segments
            .map((item) => normalizeSegment(item, policy, diagnostics))
            .filter((item): item is VisibleSegment => Boolean(item));
        if (policy.dedup.exact) segments = removeAdjacentExact(segments, diagnostics);
        return {...doc, segments};
    });

    // Whole-document duplicate elimination is safe and deterministic.
    const uniqueDocuments: CleanDocument[] = [];
    const seenDocs = new Set<string>();
    for (const doc of orderDocuments(normalizedDocuments, policy)) {
        const signature = documentSignature(doc);
        if (seenDocs.has(signature)) {
            diagnostics.exactDuplicatesRemoved += doc.segments.length;
            continue;
        }
        seenDocs.add(signature);
        uniqueDocuments.push(doc);
    }

    const mergedSegments: VisibleSegment[] = [];
    for (const doc of uniqueDocuments) {
        let start = 0;
        if (policy.dedup.overlap && mergedSegments.length > 0) {
            start = longestSuffixPrefix(mergedSegments, doc.segments);
            diagnostics.overlapSegmentsRemoved += start;
        }
        mergedSegments.push(...doc.segments.slice(start));
    }

    let finalSegments = policy.dedup.exact ? removeAdjacentExact(mergedSegments, diagnostics) : mergedSegments;
    if (policy.dedup.near === "lexical") finalSegments = removeBoundaryNearDuplicates(finalSegments, diagnostics);

    const document: CleanDocument = {
        schema: "clean-text/v1",
        sourceId: uniqueDocuments.length === 1 ? uniqueDocuments[0].sourceId : "merged",
        sourceIndex: 0,
        createdAt: uniqueDocuments.map((doc) => doc.createdAt).filter((value): value is number => value !== undefined).sort((a, b) => a - b)[0],
        segments: finalSegments.map((item, index) => ({...item, sourceOrder: index})),
    };
    const text = renderCanonical(document, policy);
    diagnostics.outputSegments = document.segments.length;
    return {
        document,
        text,
        inputContentHash: hashDocuments(documents),
        outputContentHash: sha256Text(text),
        policyHash: cleanupPolicyHash(policy),
        diagnostics,
    };
}

export function storedIrFromResult(result: CleanupResult): StoredCleanIr {
    return {
        schemaVersion: 1,
        body: result.text,
        outputContentHash: result.outputContentHash,
        policyHash: result.policyHash,
        segments: result.document.segments.map((item) => ({
            kind: item.kind,
            text: item.text,
            sourceOrder: item.sourceOrder,
            occurredAt: item.occurredAt,
            incomplete: item.incomplete,
            fidelity: item.fidelity,
            sourceId: item.sourceId,
        })),
    };
}

/** Best-effort fallback for old clean sessions that have cleanup_text but no cleanup_ir. */
export function parseCanonicalBody(body: string, sourceId = "clean"): VisibleSegment[] {
    const normalized = canonicalizeText(body);
    if (!normalized) return [];
    const header = /^(用户|助手|工具|上下文|断点)(?: \[[^\]]+\])?：$/;
    const lines = normalized.split("\n");
    const segments: VisibleSegment[] = [];
    let currentKind: VisibleKind | undefined;
    let currentLines: string[] = [];
    const flush = () => {
        if (!currentKind) return;
        const text = canonicalizeText(currentLines.join("\n"));
        if (text) segments.push({kind: currentKind, text, sourceOrder: segments.length, fidelity: currentKind === "checkpoint" ? "derived" : "verbatim", sourceId});
        currentKind = undefined;
        currentLines = [];
    };
    const kindMap: Record<string, VisibleKind> = {"用户": "user", "助手": "assistant", "工具": "tool", "上下文": "checkpoint", "断点": "break"};
    for (const line of lines) {
        const match = line.match(header);
        if (match && (segments.length > 0 || currentKind || currentLines.every((value) => !value.trim()))) {
            flush();
            currentKind = kindMap[match[1]];
            currentLines = [];
            continue;
        }
        if (currentKind) currentLines.push(line);
        else currentLines.push(line);
    }
    flush();
    if (segments.length === 0) return [{kind: "checkpoint", text: normalized, sourceOrder: 0, fidelity: "derived", sourceId}];
    return segments;
}
