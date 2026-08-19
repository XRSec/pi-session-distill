# Changelog

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

- canonical schema 新增 runtime environment：cwd/repository/branch/commit/worktree/tools/config keys/background jobs/external side effects。
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
