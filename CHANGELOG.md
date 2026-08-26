# Changelog

## 4.5.1 — Pi 0.84.3 compaction lifecycle integration

- `/cleanup this` 不再依赖 `ctx.compact()` 的 hook 后覆盖；它从当前 session 文件重新打开 active branch，再使用 Pi 官方 `prepareCompaction` 和 `keepRecentTokens: 0`，避免宿主在 hook 触发前按默认 20k 保留窗口误报 `Nothing to compact`，也避免 `/reload` 后旧命令上下文的内存分支快照误报“没有可提炼的消息”。
- `/cleanup this` 改为 snapshot-first 原子重建同一 session：`cleanup_merge_root` 下 active sibling 仅显示 `CompactionEntry`，原 session entry tree 复制到 `cleanup_source_root` 非 active sibling，Pi Web“完整历史”可展开原消息；原始 JSONL 还以 `gzip+base64` 的 `cleanup_history_*` hidden entries 完整嵌入。
- hidden archive 现在支持单来源，写入前后验证 source bytes/hash、压缩 hash、timeline 顺序/hash/逐行引用、非 active 原始树及 active tree；替换后验证失败会从冻结快照恢复原字节。交互式 `/cleanup this` 改为先切换到冻结 staging session、再发布 replacement、最后返回目标 session，消除刷新被取消后旧 runtime 继续写入失效 parentId 的 active-branch 断裂。返回目标 session 被外部 handler 取消时改为成功警告，不再误报 cleanup 失败。显式标题缺失时从首条用户消息生成 `session_info`，避免 Pi Web 显示 `(no messages)`。已有 checkpoint 后若只追加了 `thinking_level_change` 等元数据，full-span cleanup 仍会重新提炼当前有效 checkpoint 并继承文件操作记录。
- 新增 full-span hidden archive 与单一可见上下文回归测试，并锁定 compaction 模型请求使用独立 routing session ID 且 `cacheRetention: "none"`。
- `--print` 模式写入后不再调用同 session 的 `switchSession`，避免 checkpoint 已成功落盘但 CLI 进程不退出；非交互成功以退出码和 session 回读为准，stdout 可以为空。

## 4.5.0 — Resumable merge tree for Pi Web full history

- 新聚合 session 以 `cleanup_merge_root` 为根，将每个来源的完整 Pi session tree 复制为独立非 active 分支；entry
  ID/parentId 安全重映射，原有分支结构保持不变。
- 聚合 handoff 以 native `CompactionEntry` 作为最后追加的 active checkpoint；Pi active context 只包含
  handoff，来源消息不会泄漏到后续模型上下文，pi-web“生成标题”也可正常读取会话内容。
- 初始会话名称优先使用 LLM handoff 的 `scope.topic`，不再被 `scope.project` 文件系统路径覆盖。
- pi-web“完整历史”可直接读取同一聚合 session 的全部来源分支；hidden gzip 继续提供原始 JSONL 字节级恢复与校验。
- 新增按 source snapshot、模型、prompt version 和阶段输入哈希寻址的 checkpoint；输入哈希完全相同的 validated artifact 可跨
  append-only source snapshot 变化复用，成功发布并完成 `/tmp` 来源移动后自动删除。
- verifier 给出明确修复指令时最多执行五轮累计 targeted repair；仍不通过则继续拒绝发布。
- previous handoff 的 active hard constraints 继续作为 canonical invariant；有证据的概括性 `supersedes` 不会被旧约束重新覆盖。
- 对实际观测到的 `WebSocket error` 与 `fetch failed` 最多执行两次模型调用级有界重试；截断输出仍拒绝进入校验或 checkpoint。
- `/tmp` 来源移动 manifest 改为原子 `0600` 替换更新，修复首个来源移动后因 create-only 写入触发 `EEXIST` 的半完成故障；成功后删除冻结快照。

## 4.4.0 — Hidden exact history for multi-session handoff

- 多个明确 session ID 的 handoff 产物现在嵌入每个来源文件的完整 session tree 原始字节，而不只保存 active-branch 状态摘要。
- 原始来源使用 `gzip+base64` 分块写入 hidden Pi `custom` entries，不显示且不进入 LLM context。
- 新增跨来源全局时间线，按 `timestamp → sourceIndex → lineIndex` 稳定排序，并为每条原始 JSONL 记录保存行 SHA-256。
- 写入前后验证来源/压缩数据哈希、字节数、时间线哈希与顺序、行引用和 session 父链；失败时拒绝发布。
- hidden history 按用户要求原样保留敏感值、thinking、工具详情和附件；可见报告、canonical handoff、日志和导出仍维持脱敏边界。

## 4.3.0 — Native single-session routing and verified source archive

- `/cleanup this` 在当前会话原地追加 Pi native `CompactionEntry`。
- `/cleanup <单个 session-id>` 使用 Pi 官方 compaction preparation/cut point，在冻结和源一致性检查后原地追加并回读验证。
- `/cleanup <多个明确 session-id>` 发布并回读验证 handoff 后，将未变化源会话原子移动到权限受限的 `/tmp` 归档目录；不永久删除。
- 无参数交互选择不自动归档；`--textual` 始终只读。
- 默认 handoff 输入改用冻结 active branch 与 Pi 官方 serialization；旧 Result-First 行为仅作为历史版本记录。

## 4.1.0 — Result-First input reduction

### Result-First retrieval

- 默认 handoff/capsule 不再把完整 User → Assistant thinking/tool → Tool output 流水账送给清洗模型。
- 以“工作事务”的 **最终 Assistant 结果**作为第一数据源；只要结果完整，原始 User 请求和 Tool output 均不重复输入。
- 只有事务中断、没有最终结果时，才降级保留最后的 Assistant 状态和少量结果型 Tool 证据。
- 只有上述证据仍无法独立解释事务时，才回看 User 请求；`继续`、`开始`、进度催促等不作为独立知识输入。
- 连续 `继续`/进度催促会并入尚未完成的上一工作事务，避免把一次长任务拆成大量伪会话块。
- `read/search/grep/find` 等发现型工具默认不作为 durable result；验证、修改、错误、后台任务状态等结果型工具才可进入
  fallback。

### Context pressure

- Tool fallback 文本有确定性长度上限，保留头尾而不是整段日志/源码。
- 日志新增 rawMessages / turns / selectedMessages / droppedMessages / selectedChars / reductionPct 等 Result-First 指标。
- Handoff extractor prompt 明确输入已是 result-first records，不再要求模型重建缺失的原始问题。

### Compatibility

- 旧 cleanup 会话若只有 `compaction.summary`、没有普通 message，默认 handoff 会在无其他结果记录时读取最新 summary 作为
  legacy fallback。
- snapshot-first、secret redaction、canonical handoff、verifier 与原子发布机制保持不变。

## 4.0.0 — Agent State Handoff redesign

### Breaking/default behavior

- `/cleanup` 与 `/cleanup this` 默认从 `textual` 改为 **LLM Agent State Handoff**。
- `--textual` 显式保留 v3 的机械可见文本清理。
- v3 的 Fact Ledger / knowledge capsule 改名为 `--capsule`；`--semantic` 仅作为兼容别名。

### New canonical architecture

- 新增 `handoff.ts`。
- 新增 `AgentHandoffReport v1.0.0` canonical model。
- 新增 hidden `customType=cleanup_handoff`，用于二次/多次清洗。
- canonical report ID 与 normalized semantic hash 基于结构内容稳定生成。
- Markdown 改为 deterministic renderer，不再由最终一轮 LLM 自由作文。
- 新增 `schemas/agent-handoff-v1.schema.json`。

### Semantic pipeline

- snapshot-first 冻结源会话。
- active branch 结构化读取，thinking 排除，tool result 可作为 evidence 数据。
- LLM 前 secret redaction。
- per-chunk atomic extraction。
- canonical consolidation：目标、当前状态、runtime、constraints、timeline、decisions、work、open items、resources、actions、claims。
- 独立 adversarial verifier。
- verifier 未通过时最多一次 targeted repair。
- 第二次仍未通过：拒绝发布，不做静默 textual fallback。

### Re-clean / merge

- v4 handoff 再次 `/cleanup` 时读取旧 canonical JSON，仅提取 `cleanup_handoff` 后新增 tail。
- 无新增 tail 的单一 handoff 可零 LLM 复用，降低语义漂移。
- 多 handoff / raw session 合并基于 canonical state + new evidence，而不是 Markdown 拼接。
- 支持 active/superseded/revoked/reverted/uncertain 状态。

### Coding-agent state

- canonical schema 新增 runtime environment：cwd/repository/branch/commit/worktree/tools/config keys/background
  jobs/external side effects。
- completed work 区分 verified/reported/partial/failed。
- action 记录 priority、preconditions、side effect、approval requirement。

### Security

- source data 统一视为 untrusted input。
- prompt injection pattern 标记进入 security metadata。
- 输入与模型输出均做 secret-shaped redaction gate。
- 最终 Markdown 再扫描；发现 secret-shaped value 则拒绝发布。

### Export

- `--export-text`：额外导出最终 handoff Markdown。
- `--export-json`：额外导出 canonical JSON。

### Existing v3 fixes retained

- no `confirm` modal。
- snapshot-first source freeze。
- live source changes after snapshot only warn，不阻断 switch。
- `switchSession(..., {withSession})` fresh context lifecycle 修复。
- source session read-only / atomic 0600 output / 0700 backup directories。

## 4.2.0 - 2026-08-19

- Fixed result-first evidence loss in long unfinished tool turns: cleanup now preserves a bounded chronological set of
  durable Assistant milestones instead of only the latest status.
- Strengthened extraction/consolidation/verifier prompts against resolved-state regression (resolved blockers, verified
  probes, explicit path supersession, and stale quantitative measurements).
- Added Grok regression coverage for mail auth `401 -> 200`, live-probe completion, `Grok/cpa_proxy_state.json`
  authority, and node-health `67/215 -> 91/215 -> 191/215`.
- Updated handoff prompt version to `handoff-result-first-v1.2.0`.
