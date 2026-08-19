# Pi Session Cleanup v4.0.0 — Agent State Handoff

`session-cleanup` 现在的默认目标不再是“把聊天文本变干净”，而是把一个或多个 Pi 会话沉淀成 **写给后续 AI Agent 继续工作的状态交接工件（Agent State Handoff）**。

核心验收标准：

> 即使下一段上下文不再读取原始聊天，仅看到新的 clean session，它仍应知道当前目标、用户约束、当前真实状态、已经验证完成的工作、被推翻的决策、尚未解决的问题、关键文件/环境以及下一步可安全执行的动作。

## 三种模式

### 默认：Agent Handoff

```text
/cleanup this
```

流程：

```text
freeze source snapshot
→ active-branch normalize
→ secret redaction / injection labeling
→ per-chunk atomic extraction
→ canonical consolidation
→ adversarial verifier
→ optional targeted repair
→ canonical JSON
→ deterministic Markdown renderer
→ atomic new-session publish
→ switchSession(withSession)
```

这不是聊天摘要，也不是逐条“用户/助手”复述。默认 Markdown 结构为：

```text
# 主题
## 当前状态摘要
## 运行环境 / 工作树            （有信息时）
## 演进脉络
## 当前有效约束
## 关键决策
## 完成的工作与验证
## 关键文件 / 资源
## 未决事项 / 风险              （有信息时）
## 可执行下一步                 （有信息时）
## 整体结论 / 当前状态
```

隐藏的 canonical JSON 则额外保存：claims、evidence、supersession、provenance、security、quality 等机器语义。

### 机械文本模式

```text
/cleanup --textual this
```

只做确定性文本投影：去 thinking/tool control/runtime metadata、按策略保留工具文本、去重与脱敏。**不调用 LLM，不做语义沉淀。**

### 知识胶囊模式

```text
/cleanup --capsule this
```

保留 v3 的 Fact Ledger → Knowledge Capsule 路径，适合高压缩长期知识，而不是完整 task handoff。

兼容旧命令：

```text
/cleanup --semantic this
```

等价于 `--capsule`。

---

## 常用命令

```text
/cleanup this
/cleanup <session-id-1> <session-id-2>
/cleanup

/cleanup --textual this
/cleanup --capsule this

/cleanup --export-text this
/cleanup --export-json this
```

`--export-text` 会把最终 Markdown/TXT 额外写到：

```text
~/.pi/agent/session-cleanup-exports/
```

`--export-json` 仅 handoff 模式有效，用于额外导出 canonical JSON。

默认不落地额外导出文件；clean session 自身就是正式产物。

## 多会话合并

多个关联会话不是字符串拼接，而是：

```text
Session A ─┐
Session B ─┼→ atomic fragments → canonical state merge → conflict/supersession → verifier
Session C ─┘
```

合并时重点处理：

- 同一用户约束的重复/更新；
- 旧决策被新决策推翻；
- “用户要求”与“当前实际状态”并存但不混为一谈；
- 第一次测试与后续复测结果冲突；
- assistant 自报“完成”但测试/工具证据失败；
- 失败尝试是否会影响后续决策；
- 多 session 的关键文件、环境状态和未完成事项。

## 二次 / 多次清洗

v4 clean session 内部包含隐藏条目：

```text
customType=cleanup_handoff
```

它保存 canonical JSON。

再次执行：

```text
/cleanup this
```

时：

```text
previous cleanup_handoff JSON
+
cleanup_handoff 之后新增的 raw tail
→ consolidate / verify
→ new handoff
```

不会只对旧 Markdown 做“摘要的摘要”。

如果单个 v4 handoff session **完全没有新增 tail**，会直接复用 canonical state，避免无意义的 LLM 再生成和语义漂移。`reportId` 与 `normalizedContentHash` 对同一语义状态保持稳定。

## 证据与事实等级

v4 明确区分：

- 用户明确要求 / 硬约束；
- 工具、测试、文件、diff 等观测事实；
- assistant 自报结果；
- 推断；
- 未验证状态。

完成项状态：

```text
verified  — 有验证证据
reported  — 仅被报告完成，证据不足
partial   — 部分完成
failed    — 明确失败
```

决策状态：

```text
active / proposed / superseded / reverted / uncertain
```

约束状态：

```text
active / superseded / revoked / uncertain
```

这避免把“计划”误写成“完成”、把旧配置误写成当前状态。

## Coding Agent 专用信息

canonical handoff 支持：

- cwd / repository / branch / commit；
- worktree 状态；
- 工具/版本；
- 相关配置键（不保存 secret value）；
- background jobs；
- 已发生 external side effects；
- 文件、目录、symbol、commit、diff、log、API、数据库等资源；
- 测试命令、验证结果、失败原因；
- blocked / ready / optional 下一步。

## 安全

默认 handoff 模式始终：

1. 在发送给 LLM 前做 secret-shaped redaction；
2. 将网页/附件/tool result/日志中的指令视为不可信数据；
3. 对典型 prompt-injection 文本做标记；
4. 不把 source 中的恶意指令自动提升为 `actions`；
5. 输出后再次做 secret-shaped 扫描；
6. 源 session 永远只读；
7. snapshot、log、export、产物权限使用 `0700/0600`。

## 质量门禁

默认 handoff 需要独立 verifier 对以下 7 项打 1–5 分：

- `stateFidelity`
- `constraintRecall`
- `decisionSupersession`
- `completionAccuracy`
- `openItemRecall`
- `evidenceFaithfulness`
- `concision`

所有项至少 4 分且无 critical issue 才发布。

第一次失败时只做 **一次 targeted repair**；第二次仍失败则本次 `/cleanup` 失败，不会偷偷降级成 textual 然后继续称为 handoff。

## 安装

```bash
unzip pi-session-cleanup-v4.0.0-agent-handoff.zip
cd pi-session-cleanup-v4.0.0-agent-handoff
./install.sh
```

默认安装到：

```text
~/.pi/agent/extensions/session-cleanup/
```

如果目标目录已存在，安装脚本会先整体备份旧目录。

重启 Pi 后使用：

```text
/cleanup this
```

## 测试

```bash
npm test
```

当前包包含：

- v3 的 deterministic textual / snapshot / switch 生命周期回归；
- v4 handoff fragment/evidence 验证；
- stable semantic hash / report ID；
- deterministic Markdown renderer；
- handoff session writer；
- verifier gate；
- prompt-injection 标记。

详细结果见 `VALIDATION.md`。

## 文件结构

```text
index.ts                         Pi extension entry / orchestration
handoff.ts                       v4 canonical Agent Handoff model + prompts + validators + renderer
core.ts                          snapshot / source / legacy capsule helpers
textual.ts                       deterministic textual projection / IR
session-writer.ts                textual + handoff session serialization
schemas/agent-handoff-v1.schema.json
DESIGN.md                        v4 architecture and invariants
references/agent-handoff-design.md
references/pi-session-format.md
scripts/smoke-test.sh
test/handoff.test.ts
```

## 设计边界

v4 不试图把所有原始证据永久复制进 Markdown。长日志、完整 diff、大型 tool payload 仍保留在 source snapshot / 原 session 中；handoff 保存高价值语义、evidence locator/hash 与 provenance。

canonical JSON 是二次清洗与机器处理的真源；Markdown 是确定性 projection。后续版本应优先扩展 schema，而不是不断改 Markdown 自由作文 prompt。
