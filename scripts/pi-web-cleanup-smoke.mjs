#!/usr/bin/env node
import fs from "node:fs";
import {execFileSync} from "node:child_process";
import {SessionManager} from "@earendil-works/pi-coding-agent";
import {hiddenHistoryArchiveFromSessionLines, hiddenHistorySourceBytes} from "../history.ts";

const DEFAULT_SOURCE_ID = "01a03f53-485f-7b0a-b8da-72282d0769c1";

function option(name, fallback) {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : fallback;
}

const sourceId = option("--source", DEFAULT_SOURCE_ID);
const baseUrl = option("--base-url", process.env.PI_WEB_URL);
const timeoutMs = Number(option("--timeout-ms", "900000"));
const openPage = process.argv.includes("--open");

const source = (await SessionManager.listAll()).find((item) => item.id === sourceId);
if (!source) throw new Error(`找不到基线会话: ${sourceId}`);

const sourceManager = SessionManager.open(source.path);
const sessionPath = sourceManager.createBranchedSession(sourceManager.getLeafId());
if (!sessionPath) throw new Error(`复制基线会话失败: ${sourceId}`);

const sessionManager = SessionManager.open(sessionPath);
const sessionId = sessionManager.getSessionId();
if (sessionId === sourceId) throw new Error("复制结果错误地复用了基线会话 ID");
const beforeBytes = fs.readFileSync(sessionPath);

console.log(JSON.stringify({sourceId, sessionId, sessionPath}, null, 2));
console.log(`执行: pi --session ${sessionId} "/cleanup this" --print`);
execFileSync("pi", ["--session", sessionId, "/cleanup this", "--print"], {
    cwd: process.cwd(),
    stdio: "inherit",
    timeout: timeoutMs,
});

const afterBytes = fs.readFileSync(sessionPath);
const reopened = SessionManager.open(sessionPath);
const entries = reopened.getEntries();
const contextRoles = reopened.buildSessionContext().messages.map((message) => message.role);
const mergeRoot = entries.find((entry) => entry.type === "custom" && entry.customType === "cleanup_merge_root");
const sourceRoot = entries.find((entry) => entry.type === "custom_message" && entry.customType === "cleanup_source_root");
const branchLabel = reopened.buildContextEntries()[0]?.details?.branchLabel;
const archive = hiddenHistoryArchiveFromSessionLines([reopened.getHeader(), ...reopened.getBranch()]);
const archivedBytes = hiddenHistorySourceBytes(archive, sessionId);
const baselinePreservedInArchive = archivedBytes.subarray(0, beforeBytes.length).equals(beforeBytes);
const sourceRootHidden = sourceRoot?.display === false && sourceRoot.parentId === mergeRoot?.id;
const sourceRootActive = sourceRoot ? reopened.getBranch().some((entry) => entry.id === sourceRoot.id) : true;
const pageUrl = baseUrl ? new URL(`/?session=${encodeURIComponent(sessionId)}`, baseUrl).href : undefined;
const result = {
    sourceId,
    sessionId,
    sessionPath,
    beforeBytes: beforeBytes.length,
    afterBytes: afterBytes.length,
    archivedBytes: archivedBytes.length,
    baselinePreservedInArchive,
    sourceRootHidden,
    sourceRootActive,
    branchLabel,
    contextRoles,
    contextCount: contextRoles.length,
    pageUrl,
};
console.log(JSON.stringify(result, null, 2));

if (!baselinePreservedInArchive) throw new Error("hidden archive 未逐字保留启动 CLI 前的基线副本");
if (!sourceRootHidden || sourceRootActive) throw new Error("原历史未隔离到 display:false 的非 active 分支");
if (!/^PSD M \d{2}\/\d{2} \d{2}:\d{2}$/.test(branchLabel ?? "")) {
    throw new Error(`分支标签缺少工具名、手动压缩标记或时间: ${String(branchLabel)}`);
}
if (contextRoles.length !== 1 || contextRoles[0] !== "compactionSummary") {
    throw new Error(`active context 不是单一 checkpoint: ${JSON.stringify(contextRoles)}`);
}

if (openPage) {
    if (!pageUrl) throw new Error("--open 需要 --base-url 或 PI_WEB_URL");
    execFileSync("open", [pageUrl]);
}
if (pageUrl) console.log(`页面验收: ${pageUrl}`);
else console.log("追加 --base-url <Pi Web URL> 可输出页面验收链接；追加 --open 可在验证后打开。");
