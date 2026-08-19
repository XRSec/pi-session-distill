import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export function validateSessionHeaderLine(line: string, expectedId: string): number {
    let header: {type?: string; version?: number; id?: string};
    try {
        header = JSON.parse(line) as {type?: string; version?: number; id?: string};
    } catch {
        throw new Error("无效会话头 JSON");
    }
    if (header.type !== "session") throw new Error("无效会话头");
    if (header.id !== expectedId) throw new Error(`源会话 header ID 不匹配: ${expectedId}`);
    return header.version ?? 1;
}

export interface SourceRef {
    source: string;
    sourceId: string;
}

export interface PreservedSource {
    sourcePath: string;
    sha256: string;
}

export interface SessionCandidate {
    path: string;
    id: string;
    cwd: string;
    name?: string;
    timestamp?: string;
}

export interface Capsule {
    title: string;
    domain: string;
    markdown: string;
    coveredSourceIds: string[];
}

export type FactCategory = "state" | "capability" | "entry_point" | "decision" | "invariant" | "failure" | "fix" | "verification" | "constraint" | "open_work";
export type FactStatus = "current" | "historical" | "superseded" | "unresolved";
export type FactConfidence = "verified" | "inferred";

export interface FactRecord {
    factId: string;
    subject: string;
    domainId: string;
    category: FactCategory;
    statement: string;
    status: FactStatus;
    confidence: FactConfidence;
    asOf: string;
    sourceIds: string[];
    supersedesFactIds: string[];
}

export interface FactLedger {
    domainCandidates: string[];
    facts: FactRecord[];
    coveredSourceIds: string[];
}

export interface CapsuleReview {
    pass: boolean;
    scores: {
        scopePurity: number;
        currentState: number;
        contradictionResolution: number;
        actionability: number;
        concision: number;
        sourceFaithfulness: number;
    };
    evidence: Array<{
        criterion: keyof CapsuleReview["scores"];
        section: string;
        factIds: string[];
    }>;
    issues: string[];
    rewriteInstructions: string;
}

export interface InputStats {
    sourceCount: number;
    messageCount: number;
    chunkCount: number;
    rawChars: number;
}

const REQUIRED_HEADINGS = [
    "## Current State",
    "## System Map",
    "## Decisions and Invariants",
    "## Lessons from Failures",
    "## Open Work",
    "## How to Resume",
    "## Evidence Boundaries",
] as const;

const FACT_CATEGORIES = new Set<FactCategory>(["state", "capability", "entry_point", "decision", "invariant", "failure", "fix", "verification", "constraint", "open_work"]);
const FACT_STATUSES = new Set<FactStatus>(["current", "historical", "superseded", "unresolved"]);
const FACT_CONFIDENCES = new Set<FactConfidence>(["verified", "inferred"]);

/** Exclude assistant thinking blocks before serialization. */
export function stripAssistantThinking(message: unknown): unknown {
    if (!message || typeof message !== "object" || Array.isArray(message)) return message;
    const value = message as {role?: unknown; content?: unknown};
    if (value.role !== "assistant" || !Array.isArray(value.content)) return message;
    return {
        ...value,
        content: value.content.filter((block) => !block || typeof block !== "object" || (block as {type?: unknown}).type !== "thinking"),
    };
}

export function safeError(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    return raw.slice(0, 500);
}

export function resolveSessionIds(
    all: SessionCandidate[],
    rawIds: string[],
    cwd: string,
    currentId: string,
): SessionCandidate[] {
    if (rawIds.length === 0) throw new Error("未提供会话 ID");
    const resolved: SessionCandidate[] = [];
    const seen = new Set<string>();
    const expectedCwd = path.resolve(cwd);

    for (const raw of rawIds) {
        const id = raw.trim().toLowerCase();
        if (!id) throw new Error("会话 ID 不能为空");
        const exact = all.filter((item) => item.id.toLowerCase() === id);
        const matches = exact.length > 0 ? exact : all.filter((item) => item.id.toLowerCase().startsWith(id));
        if (matches.length === 0) throw new Error(`未找到会话: ${raw}`);
        if (matches.length > 1) throw new Error(`会话 ID 前缀有歧义: ${raw}`);
        const match = matches[0];
        if (path.resolve(match.cwd || ".") !== expectedCwd) throw new Error(`会话不属于当前 cwd: ${raw}`);
        if (seen.has(match.id)) throw new Error(`重复会话: ${raw}`);
        seen.add(match.id);
        resolved.push(match);
    }
    if (resolved.length > 1 && resolved.some((item) => item.id === currentId)) {
        throw new Error("当前会话不能显式混入合并");
    }
    return resolved;
}

function stableMessage(message: unknown): string {
    return JSON.stringify(message);
}

/** Add retainedTail only when the installed SessionManager did not materialize it. */
export function preserveRetainedTail(messages: unknown[], branchEntries: unknown[]): unknown[] {
    const compactions = branchEntries.filter(
        (entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && (entry as Record<string, unknown>).type === "compaction"),
    );
    const latest = compactions.at(-1);
    const tail = Array.isArray(latest?.retainedTail) ? latest.retainedTail : [];
    if (tail.length === 0) return [...messages];

    const needles = tail.map(stableMessage);
    const haystack = messages.map(stableMessage);
    const summaryIndex = messages.findIndex((message) => {
        if (!message || typeof message !== "object") return false;
        const value = message as Record<string, unknown>;
        return value.role === "compactionSummary" && value.summary === latest?.summary;
    });
    if (summaryIndex >= 0 && needles.every((needle, index) => haystack[summaryIndex + 1 + index] === needle)) {
        return [...messages];
    }

    const insertAt = summaryIndex >= 0 ? summaryIndex + 1 : 0;
    return [...messages.slice(0, insertAt), ...tail, ...messages.slice(insertAt)];
}

function messageRole(message: unknown): string | undefined {
    return message && typeof message === "object" ? (message as {role?: string}).role : undefined;
}

function hasToolCall(message: unknown): boolean {
    if (!message || typeof message !== "object") return false;
    const content = (message as {content?: unknown}).content;
    return Array.isArray(content) && content.some((part) => {
        if (!part || typeof part !== "object") return false;
        const type = (part as {type?: string}).type;
        return type === "toolCall" || type === "tool_call";
    });
}

/** Keep an assistant tool call and all immediately following tool results in one atomic block. */
export function groupMessageTransactions(messages: unknown[]): unknown[][] {
    const groups: unknown[][] = [];
    for (let index = 0; index < messages.length; index++) {
        const group = [messages[index]];
        if (messageRole(messages[index]) === "assistant" && hasToolCall(messages[index])) {
            while (index + 1 < messages.length && messageRole(messages[index + 1]) === "toolResult") {
                group.push(messages[++index]);
            }
        }
        groups.push(group);
    }
    return groups;
}

export function chunkWholeBlocks(blocks: string[], maxChars: number): string[][] {
    if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error("maxChars 必须为正整数");
    const chunks: string[][] = [];
    let current: string[] = [];
    let size = 0;
    for (const block of blocks) {
        const addition = block.length + (current.length > 0 ? 2 : 0);
        if (current.length > 0 && size + addition > maxChars) {
            chunks.push(current);
            current = [];
            size = 0;
        }
        current.push(block);
        size += block.length + (current.length > 1 ? 2 : 0);
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
}

function modelObject(raw: string, stopReason: string): Record<string, unknown> {
    if (stopReason !== "stop") throw new Error(`模型未正常停止: ${stopReason}`);
    if (/^\s*```/.test(raw)) throw new Error("模型响应不能用 Markdown fence 包裹 JSON");
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        throw new Error("模型响应不是有效 JSON");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("模型响应必须是 JSON 对象");
    return value as Record<string, unknown>;
}

function sortedUniqueStrings(values: string[]): string[] {
    return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function validateSupersedesGraph(facts: FactRecord[]): void {
    const byId = new Map(facts.map((fact) => [fact.factId, fact]));
    for (const fact of facts) {
        for (const targetId of fact.supersedesFactIds) {
            const target = byId.get(targetId);
            if (!target || targetId === fact.factId) throw new Error(`supersedesFactIds 引用无效: ${fact.factId}`);
            if (target.domainId !== fact.domainId || target.subject !== fact.subject || target.status !== "superseded") {
                throw new Error(`supersedesFactIds 语义无效: ${fact.factId}`);
            }
        }
    }

    const state = new Map<string, "visiting" | "visited">();
    const visit = (factId: string): void => {
        if (state.get(factId) === "visiting") throw new Error(`supersedesFactIds 存在环: ${factId}`);
        if (state.get(factId) === "visited") return;
        state.set(factId, "visiting");
        for (const targetId of byId.get(factId)?.supersedesFactIds ?? []) visit(targetId);
        state.set(factId, "visited");
    };
    for (const fact of facts) visit(fact.factId);
}

function coveredIds(value: unknown, expectedSourceIds: string[]): string[] {
    if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !id)) throw new Error("coveredSourceIds 无效");
    const covered = value as string[];
    const expected = sortedUniqueStrings(expectedSourceIds);
    if (new Set(covered).size !== covered.length || [...covered].sort((left, right) => left.localeCompare(right)).join("\0") !== expected.join("\0")) {
        throw new Error("直接来源覆盖不完整或包含重复/额外来源");
    }
    return covered;
}

export function validateFactLedgerResponse(raw: string, stopReason: string, expectedSourceIds: string[]): FactLedger {
    const object = modelObject(raw, stopReason);
    const slug = /^[A-Za-z0-9][A-Za-z0-9._:#\- ]{0,199}$/;
    if (!Array.isArray(object.domainCandidates) || object.domainCandidates.length === 0 || object.domainCandidates.some((domain) => typeof domain !== "string" || !slug.test(domain))) {
        throw new Error("domainCandidates 无效");
    }
    if (!Array.isArray(object.facts) || object.facts.length === 0) throw new Error("facts 为空");
    const covered = coveredIds(object.coveredSourceIds, expectedSourceIds);
    const expected = new Set(expectedSourceIds);
    const expectedCi = new Map<string, string>();
    for (const id of expectedSourceIds) expectedCi.set(id.toLowerCase(), id);
    const normalizeConfidence = (value: unknown): FactConfidence => {
        if (typeof value === "string" && FACT_CONFIDENCES.has(value as FactConfidence)) return value as FactConfidence;
        const v = typeof value === "string" ? value.trim().toLowerCase() : "";
        if (v === "high" || v === "certain" || v === "confirmed" || v === "definite" || v === "known") return "verified";
        return "inferred";
    };
    const normalizeCategory = (value: unknown): FactCategory => {
        if (typeof value === "string" && FACT_CATEGORIES.has(value as FactCategory)) return value as FactCategory;
        const v = typeof value === "string" ? value.trim().toLowerCase().replace(/[_\-\s]+/g, "_") : "";
        if (v === "state" || v === "current_state") return "state";
        if (v === "capability" || v === "feature" || v === "ability") return "capability";
        if (v === "entry_point" || v === "entrypoint" || v === "entry") return "entry_point";
        if (v === "decision" || v === "choice") return "decision";
        if (v === "invariant" || v === "constant") return "invariant";
        if (v === "failure" || v === "error" || v === "bug") return "failure";
        if (v === "fix" || v === "patch" || v === "repair") return "fix";
        if (v === "verification" || v === "verify" || v === "test") return "verification";
        if (v === "constraint" || v === "limit" || v === "limitation") return "constraint";
        if (v === "open_work" || v === "openwork" || v === "open" || v === "todo") return "open_work";
        return "state";
    };
    const normalizeStatus = (value: unknown): FactStatus => {
        if (typeof value === "string" && FACT_STATUSES.has(value as FactStatus)) return value as FactStatus;
        const v = typeof value === "string" ? value.trim().toLowerCase() : "";
        if (v === "active" || v === "now" || v === "present") return "current";
        if (v === "past" || v === "old" || v === "done") return "historical";
        if (v === "supersede" || v === "replaced" || v === "stale") return "superseded";
        return "unresolved";
    };
    const resolveSourceId = (id: string): string => {
        if (expected.has(id)) return id;
        const lower = id.toLowerCase();
        const ci = expectedCi.get(lower);
        if (ci) return ci;
        for (const expectedId of expectedSourceIds) {
            if (expectedId.toLowerCase().includes(lower) || lower.includes(expectedId.toLowerCase())) return expectedId;
        }
        return id;
    };
    const facts: FactRecord[] = object.facts.map((item, index) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`fact ${index + 1} 无效`);
        const fact = item as Record<string, unknown>;
        if (typeof fact.factId !== "string" || !slug.test(fact.factId)) throw new Error(`fact ${index + 1} factId 无效`);
        if (typeof fact.subject !== "string" || !slug.test(fact.subject)) throw new Error(`fact ${index + 1} subject 无效`);
        if (typeof fact.domainId !== "string" || !slug.test(fact.domainId)) throw new Error(`fact ${index + 1} domainId 无效`);
        if (typeof fact.statement !== "string" || !fact.statement.trim() || fact.statement.length > 800 || /[\r\n]/.test(fact.statement)) throw new Error(`fact ${index + 1} statement 无效`);
        if (typeof fact.asOf !== "string" || !fact.asOf.trim() || fact.asOf.length > 100 || /[\r\n]/.test(fact.asOf)) throw new Error(`fact ${index + 1} asOf 无效`);
        const category = normalizeCategory(fact.category);
        const status = normalizeStatus(fact.status);
        const confidence = normalizeConfidence(fact.confidence);
        if (!Array.isArray(fact.sourceIds) || fact.sourceIds.length === 0) throw new Error(`fact ${index + 1} sourceIds 无效`);
        const resolvedSourceIds = [...new Set((fact.sourceIds as unknown[]).filter((id): id is string => typeof id === "string" && id.length > 0).map(resolveSourceId))];
        if (resolvedSourceIds.length === 0) throw new Error(`fact ${index + 1} sourceIds 无效`);
        if (!Array.isArray(fact.supersedesFactIds)) fact.supersedesFactIds = [];
        fact.supersedesFactIds = (fact.supersedesFactIds as unknown[]).filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 200);
        return {
            factId: fact.factId,
            subject: fact.subject,
            domainId: fact.domainId,
            category,
            statement: fact.statement.trim(),
            status,
            confidence,
            asOf: fact.asOf.trim(),
            sourceIds: resolvedSourceIds,
            supersedesFactIds: [...new Set(fact.supersedesFactIds as string[])],
        };
    });
    const factIds = new Set<string>();
    const normalizedStatements = new Set<string>();
    const currentSubjects = new Set<string>();
    for (const fact of facts) {
        if (factIds.has(fact.factId)) throw new Error(`factId 重复: ${fact.factId}`);
        factIds.add(fact.factId);
        const normalized = `${fact.domainId}\0${fact.subject}\0${fact.statement.toLowerCase().replace(/\s+/g, " ")}`;
        if (normalizedStatements.has(normalized)) throw new Error(`事实重复: ${fact.factId}`);
        normalizedStatements.add(normalized);
        if (fact.status === "current" && fact.category === "state") {
            const key = `${fact.domainId}\0${fact.subject}`;
            if (currentSubjects.has(key)) throw new Error(`同一主题存在多个 current 事实: ${fact.subject}`);
            currentSubjects.add(key);
        }
    }
    validateSupersedesGraph(facts);
    const factSources = new Set(facts.flatMap((fact) => fact.sourceIds));
    if (factSources.size !== expected.size || [...expected].some((id) => !factSources.has(id))) throw new Error("facts 未实际覆盖全部来源");
    const domains = sortedUniqueStrings(object.domainCandidates as string[]);
    const factDomains = sortedUniqueStrings(facts.map((fact) => fact.domainId));
    if (domains.join("\0") !== factDomains.join("\0")) throw new Error("domainCandidates 与 facts.domainId 不一致");
    return {domainCandidates: domains, facts, coveredSourceIds: covered};
}

export function singleFactLedgerDomain(ledger: FactLedger): string {
    const domain = ledger.domainCandidates.join("+");
    if (domain.length > 100) throw new Error(`组合领域标识过长: ${ledger.domainCandidates.join(", ")}`);
    return domain;
}

export function remapFactLedgerSources(ledger: FactLedger, sourceId: string): FactLedger {
    return {...ledger, coveredSourceIds: [sourceId], facts: ledger.facts.map((fact) => ({...fact, sourceIds: [sourceId]}))};
}

export function assertFactLedgerDomainsPreserved(inputs: FactLedger[], output: FactLedger): void {
    const expected = sortedUniqueStrings(inputs.flatMap((ledger) => ledger.domainCandidates));
    const actual = sortedUniqueStrings(output.domainCandidates);
    if (actual.join("\0") !== expected.join("\0")) throw new Error("reduce 改写或丢失了输入领域");
}

export function validateCapsuleResponse(raw: string, stopReason: string, expectedSourceIds: string[], expectedDomain?: string): Capsule {
    const object = modelObject(raw, stopReason);
    if (typeof object.title !== "string" || !object.title.trim() || object.title.length > 200) throw new Error("title 无效");
    if (typeof object.domain !== "string" || !object.domain.trim() || object.domain.length > 100 || object.domain.trim().toUpperCase() === "AMBIGUOUS") throw new Error("domain 无效或存在多个独立领域");
    if (expectedDomain && object.domain.trim() !== expectedDomain) throw new Error(`domain 与事实账本不一致: ${object.domain}`);
    if (typeof object.markdown !== "string" || !object.markdown.trim() || object.markdown.length > 12_000) throw new Error("markdown 为空或过长");
    const covered = coveredIds(object.coveredSourceIds, expectedSourceIds);
    const rawLines = object.markdown.split("\n");
    const secondLevel = rawLines.map((line) => line.trim()).filter((line) => /^##\s/.test(line));
    if (secondLevel.join("\0") !== REQUIRED_HEADINGS.join("\0")) throw new Error("二级章节必须按固定顺序且不得增加、缺失或重复");
    for (const heading of REQUIRED_HEADINGS) {
        const start = rawLines.findIndex((line) => line.trim() === heading);
        const end = rawLines.findIndex((line, index) => index > start && /^##\s/.test(line.trim()));
        const body = rawLines.slice(start + 1, end === -1 ? undefined : end).join("\n").trim();
        if (!body) throw new Error(`章节为空: ${heading}`);
    }
    const provenanceMarkers = /(?:session-cleanup-backups|cleanup_manifest|coveredSourceIds|fact-ledger|##\s+Source Coverage|\.pi\/agent\/sessions\/)/i;
    if (provenanceMarkers.test(object.markdown) || expectedSourceIds.some((id) => object.markdown.includes(id))) throw new Error("来源追溯细节不得占用知识胶囊正文");
    const paragraphs = object.markdown.split(/\n\s*\n/).map((paragraph) => paragraph.trim().replace(/\s+/g, " ")).filter((paragraph) => paragraph.length >= 80 && !/^#{1,6}\s/.test(paragraph));
    if (new Set(paragraphs).size !== paragraphs.length) throw new Error("正文包含重复段落");
    const fenceCount = object.markdown.match(/```/g)?.length ?? 0;
    if (fenceCount % 2 !== 0) throw new Error("Markdown fence 未闭合");
    return {title: object.title.trim(), domain: object.domain.trim(), markdown: object.markdown.trim(), coveredSourceIds: covered};
}

export function validateCapsuleResponseLenient(raw: string, stopReason: string, expectedSourceIds: string[]): Capsule {
    const object = modelObject(raw, stopReason);
    let title = typeof object.title === "string" ? object.title.trim() : "";
    if (!title) title = "清洗后的会话摘要";
    if (title.length > 200) title = title.slice(0, 200);
    let domain = typeof object.domain === "string" ? object.domain.trim() : "";
    if (!domain || domain.toUpperCase() === "AMBIGUOUS") domain = expectedSourceIds[0] ?? "session";
    if (domain.length > 100) domain = domain.slice(0, 100);
    let markdown = typeof object.markdown === "string" ? object.markdown.trim() : "";
    if (!markdown) throw new Error("markdown 为空");
    if (markdown.length > 12_000) markdown = markdown.slice(0, 12_000);
    const covered = Array.isArray(object.coveredSourceIds) ? (object.coveredSourceIds as unknown[]).filter((id): id is string => typeof id === "string" && id) : expectedSourceIds;
    return {title, domain, markdown, coveredSourceIds: covered};
}

export function validateCapsuleReviewResponse(
    raw: string,
    stopReason: string,
    validFactIds?: Set<string>,
    requiredFactIds?: Set<string>,
): CapsuleReview {
    const object = modelObject(raw, stopReason);
    if (typeof object.pass !== "boolean") throw new Error("review pass 无效");
    if (!object.scores || typeof object.scores !== "object" || Array.isArray(object.scores)) throw new Error("review scores 无效");
    const scoreObject = object.scores as Record<string, unknown>;
    const keys = ["scopePurity", "currentState", "contradictionResolution", "actionability", "concision", "sourceFaithfulness"] as const;
    const scores = Object.fromEntries(keys.map((key) => {
        const score = scoreObject[key];
        if (!Number.isInteger(score) || (score as number) < 1 || (score as number) > 5) throw new Error(`review score 无效: ${key}`);
        return [key, score];
    })) as CapsuleReview["scores"];
    if (!Array.isArray(object.evidence) || object.evidence.length !== keys.length) throw new Error("review evidence 无效");
    const seenCriteria = new Set<string>();
    const evidence = object.evidence.map((item, index) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`review evidence ${index + 1} 无效`);
        const entry = item as Record<string, unknown>;
        if (!keys.includes(entry.criterion as typeof keys[number]) || seenCriteria.has(entry.criterion as string)) throw new Error(`review evidence criterion 无效: ${String(entry.criterion)}`);
        seenCriteria.add(entry.criterion as string);
        if (typeof entry.section !== "string") throw new Error(`review evidence section 无效: ${String(entry.section)}`);
        const section = entry.section.trim().startsWith("## ") ? entry.section.trim() : `## ${entry.section.trim()}`;
        if (!REQUIRED_HEADINGS.includes(section as typeof REQUIRED_HEADINGS[number])) throw new Error(`review evidence section 无效: ${String(entry.section)}`);
        if (!Array.isArray(entry.factIds) || entry.factIds.length === 0 || entry.factIds.some((id) => typeof id !== "string" || (validFactIds && !validFactIds.has(id)))) throw new Error(`review evidence factIds 无效: ${String(entry.criterion)}`);
        return {criterion: entry.criterion as keyof CapsuleReview["scores"], section, factIds: [...new Set(entry.factIds as string[])]};
    });
    const citedFactIds = new Set(evidence.flatMap((entry) => entry.factIds));
    if (requiredFactIds) {
        const missing = [...requiredFactIds].filter((factId) => !citedFactIds.has(factId));
        if (missing.length > 0) throw new Error(`review evidence 未覆盖关键 facts: ${missing.join(", ")}`);
    }
    if (!Array.isArray(object.issues) || object.issues.some((issue) => typeof issue !== "string" || !issue.trim())) throw new Error("review issues 无效");
    if (typeof object.rewriteInstructions !== "string") throw new Error("rewriteInstructions 无效");
    const issues = object.issues as string[];
    const scoresPass = Object.values(scores).every((score) => score >= 4);
    if (object.pass !== scoresPass) throw new Error("review pass 与 scores 不一致");
    if (!object.pass && (issues.length === 0 || !object.rewriteInstructions.trim())) throw new Error("未通过 review 必须给出问题和重写指令");
    if (object.pass && (issues.length > 0 || object.rewriteInstructions.trim())) throw new Error("已通过 review 不应包含问题或重写指令");
    const review: CapsuleReview = {pass: object.pass, scores, evidence, issues, rewriteInstructions: object.rewriteInstructions};
    return review;
}

export function capsuleReviewPasses(review: CapsuleReview): boolean {
    return review.pass && Object.values(review.scores).every((score) => score >= 4);
}

export function collectImportSources(direct: SourceRef[], branches: unknown[][]): SourceRef[] {
    const result: SourceRef[] = [];
    const seen = new Set<string>();
    const add = (ref: SourceRef) => {
        if (!ref.source || !ref.sourceId) return;
        const key = `${ref.source}\0${ref.sourceId}`;
        if (seen.has(key)) return;
        seen.add(key);
        result.push({source: ref.source, sourceId: ref.sourceId});
    };
    direct.forEach(add);
    for (const entries of branches) {
        for (const entry of entries) {
            if (!entry || typeof entry !== "object") continue;
            const value = entry as Record<string, unknown>;
            if (value.type !== "custom" || value.customType !== "import_source" || !value.data || typeof value.data !== "object") continue;
            const data = value.data as Record<string, unknown>;
            if (typeof data.source === "string" && typeof data.sourceId === "string") add({source: data.source, sourceId: data.sourceId});
        }
    }
    return result;
}

function entryId(): string {
    return crypto.randomBytes(4).toString("hex");
}

export function sessionJsonl(lines: Array<Record<string, unknown>>): string {
    return lines.map((line) => `${JSON.stringify(line)}\n`).join("");
}

function fsyncDirectory(directory: string): void {
    const dirFd = fs.openSync(directory, "r");
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
}

export function atomicWrite0600(destination: string, content: string | Buffer): void {
    fs.mkdirSync(path.dirname(destination), {recursive: true});
    const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${crypto.randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
        fd = fs.openSync(temporary, "wx", 0o600);
        fs.writeFileSync(fd, content);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.chmodSync(temporary, 0o600);
        fs.linkSync(temporary, destination);
        fs.unlinkSync(temporary);
        fsyncDirectory(path.dirname(destination));
    } catch (error) {
        if (fd !== undefined) fs.closeSync(fd);
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
        throw error;
    }
}

function atomicCopy0600(source: string, destination: string): void {
    const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${crypto.randomUUID()}.tmp`);
    try {
        fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(temporary, 0o600);
        const fd = fs.openSync(temporary, "r");
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.linkSync(temporary, destination);
        fs.unlinkSync(temporary);
        fsyncDirectory(path.dirname(destination));
    } catch (error) {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
        throw error;
    }
}

export function sha256File(filePath: string): string {
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const fd = fs.openSync(filePath, "r");
    try {
        while (true) {
            const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (bytesRead === 0) break;
            hash.update(buffer.subarray(0, bytesRead));
        }
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest("hex");
}

export function createSnapshot(sourcePaths: string[], backupRoot: string, runId: string): {directory: string; files: Array<{file: string; bytes: number; sha256: string}>} {
    if (!fs.existsSync(backupRoot)) fs.mkdirSync(backupRoot, {recursive: true, mode: 0o700});
    const directory = path.join(backupRoot, runId);
    fs.mkdirSync(directory, {recursive: false, mode: 0o700});
    fs.chmodSync(directory, 0o700);
    fsyncDirectory(backupRoot);
    const records: Array<{file: string; bytes: number; sha256: string}> = [];
    for (const [index, sourcePath] of sourcePaths.entries()) {
        const link = fs.lstatSync(sourcePath);
        if (link.isSymbolicLink() || !link.isFile()) throw new Error(`源会话必须是普通文件且不能是符号链接: ${path.basename(sourcePath)}`);
        const realPath = fs.realpathSync(sourcePath);
        const file = `${index + 1}-${path.basename(sourcePath)}`;
        const destination = path.join(directory, file);
        let readBackHash = "";
        let stable = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
            if (fs.existsSync(destination)) fs.unlinkSync(destination);
            atomicCopy0600(realPath, destination);
            const sourceHash = sha256File(realPath);
            readBackHash = sha256File(destination);
            if (sourceHash === readBackHash) {
                stable = true;
                break;
            }
        }
        if (!stable) throw new Error(`无法取得稳定源会话快照（连续 3 次发生写入）: ${file}`);
        records.push({file, bytes: fs.statSync(destination).size, sha256: readBackHash});
    }
    const manifest = {schemaVersion: 1, runId, createdAt: new Date().toISOString(), files: records};
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    atomicWrite0600(path.join(directory, "manifest.json"), manifestText);
    let readBack: {files?: typeof records};
    try {
        readBack = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8")) as {files?: typeof records};
    } catch {
        throw new Error("快照 manifest read-back JSON 无效");
    }
    if (JSON.stringify(readBack.files) !== JSON.stringify(records)) throw new Error("快照 manifest read-back 失败");
    return {directory, files: records};
}

export async function switchPreservingSources(
    capsulePath: string,
    sources: PreservedSource[],
    switcher: (filePath: string) => Promise<{cancelled: boolean}>,
    onSourceChanged?: (message: string, source: PreservedSource, phase: "切换前" | "切换期间") => void,
): Promise<{cancelled: boolean}> {
    const verify = (source: PreservedSource, phase: "切换前" | "切换期间") => {
        let changed = false;
        try {
            const link = fs.lstatSync(source.sourcePath);
            if (link.isSymbolicLink() || !link.isFile()) changed = true;
            else changed = sha256File(source.sourcePath) !== source.sha256;
        } catch {
            changed = true;
        }
        if (changed) {
            const message = `${phase}源会话发生变化（本次清洗仍使用已冻结快照）: ${path.basename(source.sourcePath)}`;
            onSourceChanged?.(message, source, phase);
        }
    };
    for (const source of sources) verify(source, "切换前");
    try {
        return await switcher(capsulePath);
    } finally {
        for (const source of sources) verify(source, "切换期间");
    }
}
