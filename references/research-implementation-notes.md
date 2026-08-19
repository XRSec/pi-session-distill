# 深度研究 → v4 实现映射

| 设计结论 | v4 实现 |
|---|---|
| 给 Agent 的产物应是 State Handoff，不是聊天摘要 | `/cleanup` 默认 `handoff` |
| canonical JSON 是真源，Markdown 是 projection | hidden `cleanup_handoff` + `renderHandoffMarkdown()` |
| claim-level evidence | deterministic evidence IDs + allowlisted `evidenceRefs` |
| 当前状态与历史演进分离 | `executiveState` + `timeline` |
| 用户约束必须显式、可 supersede/revoke | `constraints[]` |
| 决策要保留 rationale 与 supersession | `decisions[]` |
| 完成与验证分离 | `completedWork.status` + `verification` |
| Coding Agent 需工作树/环境 | `runtimeEnvironment` |
| 未完成 blocker 不能丢 | `openItems[]` |
| next step 应可执行但不能锁死未来推理 | `actions[]` 支持 ready/blocked/optional |
| 多会话合并不能拼 Markdown | chunk extraction → canonical consolidation |
| 二次清洗不能 summary-of-summary | previous `cleanup_handoff` + raw tail |
| 无 delta 时应避免语义漂移 | canonical report direct reuse |
| verifier 与 generator 分离 | consolidation pass + adversarial review pass |
| 失败质量门禁不能静默伪装成功 | verifier 二次仍失败则拒绝发布 |
| tool/附件内容不可信 | source prompt 明确 untrusted + injection flags |
| secrets 不应进入长期 clean context | pre-LLM redaction + post-generation scrub + final scan |
| snapshot 必须冻结版本 | retained v3 snapshot-first pipeline |
| session replacement 后旧 ctx 不可继续使用 | retained `switchSession(..., {withSession})` |

## v4 与 v3 的根本差异

v3 默认：

```text
visible transcript → deterministic cleanup → new transcript
```

v4 默认：

```text
raw trajectory
→ state-changing evidence
→ canonical current world state
→ verified handoff
→ deterministic Markdown
```

因此 v4 的目标不是最大化“原文保留率”，而是在不牺牲关键事实/约束/状态的前提下最大化 **continuation correctness**。
