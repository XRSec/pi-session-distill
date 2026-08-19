import * as crypto from "crypto";
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

function messageContentText(message: unknown): string {
    if (!message || typeof message !== "object" || Array.isArray(message)) return "";
    const content = (message as {content?: unknown}).content;
    if (typeof content === "string") return content.trim();
    if (!Array.isArray(content)) return "";
    return content.map((part) => {
        if (!part || typeof part !== "object") return "";
        const value = part as {type?: unknown; text?: unknown};
        return value.type === "text" && typeof value.text === "string" ? value.text : "";
    }).filter(Boolean).join("\n").trim();
}

function messageToolName(message: unknown): string {
    if (!message || typeof message !== "object" || Array.isArray(message)) return "";
    const value = message as {toolName?: unknown};
    return typeof value.toolName === "string" ? value.toolName : "";
}

function toolResultIsError(message: unknown): boolean {
    return Boolean(message && typeof message === "object" && !Array.isArray(message) && (message as {isError?: unknown}).isError === true);
}

function normalizedCompactText(text: string): string {
    return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Short acknowledgements/progress narration are not durable work results.
 * Keep this intentionally conservative: only discard phrases that carry almost no state.
 */
function isProcessOnlyAssistantText(text: string): boolean {
    const compact = normalizedCompactText(text);
    if (!compact) return true;
    if (compact.length <= 24 && /^(好的?|收到|明白|了解|可以|没问题|继续|开始|我继续|我开始|正在处理|正在检查|我先看看|我先检查|我来处理|稍等)[。！!，,\s]*$/.test(compact)) return true;

    const hasOutcomeSignal = /(已完成|完成了|已修复|修复后|已解决|解决了|根因|原因是|结论|验证|测试|\bpass\b|\bfail(?:ed)?\b|失败|错误|当前状态|仍然|仍需|剩余|未完成|未解决|阻塞|创建了|修改了|删除了|保留|决定|采用|必须|不得|不能|不应该|成功)/i.test(compact);
    if (hasOutcomeSignal) return false;

    if (compact.length <= 160 && /^(我|现在|接下来|这边)?\s*(先|会先|准备|正在|继续|开始|将|马上|接下来会|接下来我会)/.test(compact)) return true;
    return false;
}

function isLowValueUserText(text: string): boolean {
    const compact = normalizedCompactText(text);
    if (!compact) return true;
    if (compact.length <= 24 && /^(继续|继续吧|继续处理|继续优化|开始(?:\s*(?:吧|优化|处理|检查|执行))?|好|好的|可以|行|嗯|确认|你确认吗|再试试|试一下)[。！!？?，,\s]*$/.test(compact)) return true;
    return /^(为什么|怎么).{0,18}(还没好|这么久|这么慢)|^(还没好|好了没|进度怎么样|现在怎么样|你还在吗|快点)/.test(compact);
}

function isContinuationUserText(text: string): boolean {
    const compact = normalizedCompactText(text);
    if (!compact) return false;
    if (isLowValueUserText(compact)) return true;
    return /^(继续|接着|往下|继续执行|继续做|继续处理|继续优化)/.test(compact);
}

function toolEvidenceSignal(text: string, isError: boolean): number {
    const compact = normalizedCompactText(text);
    if (!compact) return 0;
    let score = isError ? 100 : 0;
    if (/(error|exception|traceback|failed|failure|timeout|timed out|aborted|blocked|拒绝|失败|错误|异常|超时|中止)/i.test(compact)) score += 80;
    if (/(\bpass(?:ed)?\b|tests?|diagnostics?|no diagnostics|验证|测试|通过|成功|clean=|0 fail|0 failed)/i.test(compact)) score += 60;
    if (/(successfully|created|updated|modified|replaced|written|wrote|saved|deleted|moved|renamed|创建|修改|替换|写入|保存|删除|移动|重命名)/i.test(compact)) score += 45;
    if (/(running|background|detached|active|pending|completed|done|finished|wait aborted|正在运行|后台|待处理|已完成)/i.test(compact)) score += 40;
    if (compact.length >= 120) score += 10;
    return score;
}

function toolEvidenceWeight(toolName: string, isError: boolean): number {
    if (isError) return 0;
    const name = toolName.trim().toLowerCase();
    if (!name) return 0;
    if (/^(read(?:_.*)?|cat|head|tail|grep|rg|ffgrep|find|glob|ls|search(?:_.*)?|remnic_lcm_search|web_search)$/.test(name)) return -1000;
    if (/(edit|write|patch|apply|move|rename|delete|mkdir|install|commit)/.test(name)) return 45;
    if (/(bash|shell|exec|test|diagnostic|lint|check|verify)/.test(name)) return 35;
    if (/(subagent|wait|job|task|workflow)/.test(name)) return 25;
    return 0;
}

function assistantHasToolCall(message: unknown): boolean {
    return messageRole(message) === "assistant" && hasToolCall(message);
}

export type ResultFirstMode = "assistant_final" | "evidence_fallback" | "user_only";

export interface ResultFirstRecord {
    turnIndex: number;
    mode: ResultFirstMode;
    /** Latest/final assistant message kept for backward compatibility. */
    assistantMessage?: unknown;
    /**
     * Chronologically ordered durable assistant milestones for an unfinished turn.
     * Keeping more than the latest status prevents a later investigation step from erasing an
     * earlier success in the same long-running turn (for example: auth restored -> live probe
     * passed -> a different state-file question discovered).
     */
    assistantMessages?: unknown[];
    assistantIsFinal: boolean;
    toolResults: unknown[];
    userMessages: unknown[];
    rawMessageCount: number;
}

export interface ResultFirstSelection {
    records: ResultFirstRecord[];
    rawMessageCount: number;
    turnCount: number;
    selectedMessageCount: number;
    droppedMessageCount: number;
    assistantFinalCount: number;
    evidenceFallbackCount: number;
    userFallbackCount: number;
}

interface WorkingTurn {
    userMessages: unknown[];
    activity: unknown[];
}

function selectToolFallbacks(activity: unknown[], maxResults = 6): unknown[] {
    const candidates = activity
        .map((message, index) => ({message, index, role: messageRole(message), text: messageContentText(message)}))
        .filter((item) => item.role === "toolResult" && item.text)
        .map((item) => {
            const tool = messageToolName(item.message);
            const isError = toolResultIsError(item.message);
            return {...item, tool, score: toolEvidenceSignal(item.text, isError) + toolEvidenceWeight(tool, isError)};
        });
    if (candidates.length === 0) return [];

    const chosen = new Map<number, typeof candidates[number]>();
    const add = (item: typeof candidates[number] | undefined) => { if (item) chosen.set(item.index, item); };

    // Always keep the newest error-like result; it may be the reason a turn is unfinished.
    add([...candidates].reverse().find((item) => toolResultIsError(item.message) || item.score >= 100));

    // Keep the newest verification, mutation, and background/status result when present.
    add([...candidates].reverse().find((item) => item.score >= 35 && /(\bpass(?:ed)?\b|tests?|diagnostics?|验证|测试|通过|0 fail|0 failed)/i.test(item.text)));
    add([...candidates].reverse().find((item) => item.score >= 35 && /(successfully|created|updated|modified|replaced|written|wrote|saved|deleted|创建|修改|替换|写入|保存|删除)/i.test(item.text)));
    add([...candidates].reverse().find((item) => item.score >= 35 && /(running|background|detached|active|pending|completed|done|finished|wait aborted|正在运行|后台|待处理|已完成)/i.test(item.text)));

    // Then keep the latest meaningful result per tool, newest tools first.
    const seenTools = new Set<string>();
    for (const item of [...candidates].reverse()) {
        if (chosen.size >= maxResults) break;
        const key = item.tool || `tool@${item.index}`;
        if (seenTools.has(key) || item.score < 35) continue;
        seenTools.add(key);
        add(item);
    }

    // Discovery/read/search output is not a durable result merely because it is large. If no
    // result-bearing tool survived, let the caller fall back to the User request instead.
    return [...chosen.values()].sort((a, b) => a.index - b.index).slice(-maxResults).map((item) => item.message);
}

function latestSubstantiveAssistant(activity: unknown[]): unknown | undefined {
    for (let index = activity.length - 1; index >= 0; index--) {
        const message = activity[index];
        if (messageRole(message) !== "assistant") continue;
        const text = messageContentText(message);
        if (text && !isProcessOnlyAssistantText(text)) return message;
    }
    return undefined;
}

function assistantMilestoneScore(text: string): number {
    const compact = normalizedCompactText(text);
    if (!compact || isProcessOnlyAssistantText(compact)) return -1000;
    let score = 0;
    if (/(已完成|完成了|已修复|已解决|恢复|通过|成功|全链路|验证通过|测试通过|返回\s*2\d\d|\bpass(?:ed)?\b|\bsuccess\b)/i.test(compact)) score += 90;
    if (/(根因|原因是|结论|当前状态|当前使用|已更新|已确认|确认.*为|可用节点|不可用节点|assigned_accounts|每节点|必须|不得|只使用|不要用)/i.test(compact)) score += 70;
    if (/(失败|错误|异常|401|阻塞|未完成|未解决|找不到|冲突|风险)/i.test(compact)) score += 55;
    if (/\b\d+\s*\/\s*\d+\b/.test(compact)) score += 35;
    if (compact.length >= 90) score += 10;
    return score;
}

/**
 * Keep a small chronological set of durable status transitions from an unfinished turn.
 * The old implementation kept only the latest Assistant status, which could erase earlier
 * resolved milestones from the same long-running tool turn.
 */
function selectAssistantFallbacks(activity: unknown[], maxMessages = 6): unknown[] {
    const candidates = activity
        .map((message, index) => ({message, index, role: messageRole(message), text: messageContentText(message)}))
        .filter((item) => item.role === "assistant" && item.text && !isProcessOnlyAssistantText(item.text))
        .map((item) => ({...item, score: assistantMilestoneScore(item.text)}));
    if (candidates.length === 0) return [];

    const chosen = new Map<number, typeof candidates[number]>();
    const latest = candidates.at(-1);
    if (latest) chosen.set(latest.index, latest);

    // Preserve state-changing milestones, especially success/failure/reversal transitions.
    for (const item of candidates) {
        if (item.score >= 55) chosen.set(item.index, item);
    }

    // Prefer the newest milestones when a pathological turn contains too many status updates,
    // but retain chronological order in the emitted evidence.
    return [...chosen.values()]
        .sort((a, b) => a.index - b.index)
        .slice(-maxMessages)
        .map((item) => item.message);
}

function terminalAssistantResult(activity: unknown[]): unknown | undefined {
    for (let index = activity.length - 1; index >= 0; index--) {
        const message = activity[index];
        const role = messageRole(message);
        if (role === "assistant") {
            const text = messageContentText(message);
            if (!text) continue; // ignore empty trailing assistant envelopes
            if (assistantHasToolCall(message) || isProcessOnlyAssistantText(text)) return undefined;
            return message;
        }
        if (role === "toolResult") return undefined; // tool activity after the last prose means the turn has no terminal result yet
    }
    return undefined;
}

function selectedEvidenceIsSelfDescribing(assistants: unknown[], tools: unknown[]): boolean {
    const assistantText = assistants.map(messageContentText).filter(Boolean).join("\n");
    if (assistantText && assistantText.length >= 80) return true;
    if (assistantText && /(根因|原因|已完成|已修复|已解决|恢复|验证|测试|通过|成功|失败|当前状态|剩余|未解决|阻塞|决定|必须|不得)/i.test(assistantText)) return true;
    const toolText = tools.map(messageContentText).join("\n");
    return toolText.length >= 180 && toolEvidenceSignal(toolText, tools.some(toolResultIsError)) >= 60;
}

/**
 * Build a high-information cleanup input from conversation turns.
 *
 * Default path: only the terminal, substantive assistant result for each user turn.
 * Fallback path (interrupted/incomplete turn): latest substantive assistant status + a small
 * set of result-bearing tool outputs. User text is included only when those results cannot
 * explain the turn by themselves. Low-value turns such as "继续" with no result are dropped.
 */
function assistantStopReason(message: unknown): string | undefined {
    if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
    const value = message as Record<string, unknown>;
    let s = value.stopReason ?? value.stop_reason;
    const nested = (value.message as Record<string, unknown> | undefined)?.stopReason;
    if (s === undefined) s = nested;
    return typeof s === "string" && s.length > 0 ? s : undefined;
}

/**
 * 退化 stutter 消息:assistant 因截断(length/error)而停止,且没有任何工具调用、只有低置信文本。
 * 这类消息常是思考/输出循环膨胀(无产出),应被过滤掉,避免污染 chunk/新会话。
 * 有工具调用的即便截断也保留(部分工具调用仍可能有价值)。
 */
export function isDegenerateAssistant(message: unknown): boolean {
    if (messageRole(message) !== "assistant") return false;
    const reason = assistantStopReason(message);
    if (reason !== "length" && !(reason && /error|max_tokens|max_tool|timeout|interrupt/i.test(reason))) return false;
    if (hasToolCall(message)) return false;
    return true;
}

export function selectResultFirstRecords(messages: unknown[]): ResultFirstSelection {
    // 退化 stutter 预过滤:截断且零工具调用的 assistant 消息不进分块/统计。
    // 保留原始引用以便把"过滤掉的消息"正确计为丢弃。
    const degenerates = new Set<unknown>();
    for (const message of messages) if (isDegenerateAssistant(message)) degenerates.add(message);
    const kept = messages.filter((message) => !degenerates.has(message));
    const degenerateDropped = degenerates.size;

    const turns: WorkingTurn[] = [];
    let current: WorkingTurn | undefined;

    const flush = () => {
        if (current && (current.userMessages.length > 0 || current.activity.length > 0)) turns.push(current);
        current = undefined;
    };

    for (const message of kept) {
        const role = messageRole(message);
        if (role === "user") {
            if (!current) {
                current = {userMessages: [], activity: []};
            } else if (current.activity.length > 0) {
                const currentFinished = Boolean(terminalAssistantResult(current.activity));
                const incoming = normalizedCompactText(messageContentText(message));
                const repeatedRequest = incoming.length > 0 && current.userMessages.some((prior) => normalizedCompactText(messageContentText(prior)) === incoming);
                if (currentFinished || (!repeatedRequest && !isContinuationUserText(incoming))) {
                    flush();
                    current = {userMessages: [], activity: []};
                } else if (repeatedRequest) {
                    // A retry of the same request while the prior attempt has no terminal result
                    // belongs to the same work transaction; do not duplicate the prompt text.
                    continue;
                }
            }
            current.userMessages.push(message);
            continue;
        }
        if (role !== "assistant" && role !== "toolResult") continue;
        if (!current) current = {userMessages: [], activity: []};
        current.activity.push(message);
    }
    flush();

    const records: ResultFirstRecord[] = [];
    for (const [turnOffset, turn] of turns.entries()) {
        const turnIndex = turnOffset + 1;
        const terminal = terminalAssistantResult(turn.activity);
        if (terminal) {
            records.push({
                turnIndex,
                mode: "assistant_final",
                assistantMessage: terminal,
                assistantMessages: [terminal],
                assistantIsFinal: true,
                toolResults: [],
                userMessages: [],
                rawMessageCount: turn.userMessages.length + turn.activity.length,
            });
            continue;
        }

        const assistantMessages = selectAssistantFallbacks(turn.activity);
        const assistant = assistantMessages.at(-1) ?? latestSubstantiveAssistant(turn.activity);
        const toolResults = selectToolFallbacks(turn.activity);
        const selfDescribing = selectedEvidenceIsSelfDescribing(assistantMessages.length ? assistantMessages : assistant ? [assistant] : [], toolResults);
        const usefulUsers = turn.userMessages.filter((message) => !isLowValueUserText(messageContentText(message)));
        const userMessages = selfDescribing ? [] : usefulUsers;

        if (assistant || toolResults.length > 0) {
            records.push({
                turnIndex,
                mode: "evidence_fallback",
                assistantMessage: assistant,
                assistantMessages,
                assistantIsFinal: false,
                toolResults,
                userMessages,
                rawMessageCount: turn.userMessages.length + turn.activity.length,
            });
            continue;
        }
        if (usefulUsers.length > 0) {
            records.push({
                turnIndex,
                mode: "user_only",
                assistantIsFinal: false,
                toolResults: [],
                userMessages: usefulUsers,
                rawMessageCount: turn.userMessages.length + turn.activity.length,
            });
        }
    }

    const selectedMessageCount = records.reduce((sum, record) => {
        const assistantCount = record.assistantMessages?.length ?? (record.assistantMessage ? 1 : 0);
        return sum + assistantCount + record.toolResults.length + record.userMessages.length;
    }, 0);
    return {
        records,
        rawMessageCount: messages.length,
        turnCount: turns.length,
        selectedMessageCount,
        droppedMessageCount: Math.max(0, messages.length - selectedMessageCount - degenerateDropped) + degenerateDropped,
        assistantFinalCount: records.filter((record) => record.mode === "assistant_final").length,
        evidenceFallbackCount: records.filter((record) => record.mode === "evidence_fallback").length,
        userFallbackCount: records.reduce((sum, record) => sum + record.userMessages.length, 0),
    };
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
            const message = `${phase}源会话发生变化: ${path.basename(source.sourcePath)}`;
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

/**
 * 从 Remnic checkpoint 式 compaction summary 里提取第一个真实对话 Excerpt 段正文。
 * Remnic 把原始对话以 `## Conversation Excerpt` 头 + `[user]`/`[assistant]`/`[toolResult]` 行封装,
 * 这正是“从压缩内容里恢复真实需要的内容”的原料;骨架(Previous Summary/残余风险等)不取。
 */
export function firstConversationExcerpt(summary: string): string | undefined {
    const header = /^##+\s*Conversation\s+Excerpt\s*$/im;
    const match = header.exec(summary);
    if (!match) return undefined;
    const rest = summary.slice(match.index + match[0].length);
    // 下一个同层标题(##/###)表示 Excerpt 段结束;取到那里为止。
    const nextHeader = /\n##+\s+[^#]/m.exec(rest);
    const excerpt = nextHeader ? rest.slice(0, nextHeader.index) : rest;
    const trimmed = excerpt.trim();
    if (!trimmed) return undefined;
    return `[Remnic conversation excerpt (from compaction)]\n${trimmed}`;
}

export function sha256String(value: string): string {
    return crypto.createHash("sha256").update(value).digest("hex");
}
