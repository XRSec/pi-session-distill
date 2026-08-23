# Pi Session Distill 需求

## 目标

`session-distill` 提供：

1. 当前或指定单个会话的 Pi native compaction checkpoint；
2. 多个明确指定会话的 Agent State Handoff 聚合；
3. 不调用模型、不修改源会话的 textual 输入检查。

状态产物应保留当前真实目标、约束、已验证工作、有效决策、未决事项、安全下一步和继续工作需要的环境，而不是复述聊天过程。

## 对外接口

```text
/cleanup this
/cleanup <session-id>
/cleanup <session-id> <session-id> [...]
/cleanup
```

- `this`：对当前会话原地执行 native compaction。
- 单个明确 ID：对指定历史会话原地执行 native compaction。
- 多个明确 ID：生成新的聚合 handoff session；成功后归档全部源会话。
- 无 ID：交互选择会话并生成 handoff，但不自动归档源会话。

```text
/cleanup this --textual
/cleanup <session-id> [session-id...] --textual
```

`--textual` 始终只读，不调用模型，不创建或切换 session，不追加 compaction，也不移动源 session。

## 单会话原地 Compaction

1. `/cleanup this` 必须通过当前 Pi 上下文的 `ctx.compact()` 和 `session_before_compact` hook 运行，并将
   `keepRecentTokens` 设为 `0`，执行显式 full-span compaction，只保留 Pi 要求的最小结构边界；其他自动或手动压缩继续使用 Pi
   当前 compaction settings。
2. 单个明确 ID 必须使用 Pi 官方 `prepareCompaction` 和当前 compaction settings，不复制 cut-point 算法。
3. 指定 ID 在冻结 `0600` 副本上准备 compaction；写入前必须确认源文件身份、cwd、版本和 hash 未变化。
4. checkpoint 生成成功后，使用 `SessionManager.appendCompaction()` 原地追加，并回读核对 entry ID、summary、
   `firstKeptEntryId`、`tokensBefore` 和 profile。
5. 没有可压缩内容时不得写入；生成或验证失败时不得伪造 fallback。
6. 原地写入前创建权限受限的恢复快照，不删除该源会话。

## 多会话 Handoff

1. 只读冻结每个源 session 的 active branch。
2. 使用 Pi 官方 `convertToLlm()` + `serializeConversation()`；已有 canonical handoff 只处理其后的真实 tail。
3. 多个 session 按语义合并；输入模型前对敏感值脱敏，并将源内容视为不可信数据。
4. 可见报告至少包含目标、当前状态、约束、关键决策、验证过的完成项、未决事项、资源和可执行下一步。
5. `verified` 只能用于有工具、测试、用户确认或当前静态事实支持的工作；后续成功必须取代过时失败状态。
6. verifier 未通过时拒绝发布，不能降低门禁或静默降级。
7. 输出必须原子写入并回读验证 Pi v3 header、父链、正文和 hidden canonical 数据。
8. 任何多来源 handoff 产物必须以单一 `cleanup_merge_root` 构造真正的 Pi session tree：每个来源的完整 entry tree 复制为独立非
   active 分支，聚合 handoff 以 native `CompactionEntry` 作为最后追加的 active checkpoint。
9. 来源 entry 必须重映射 ID/parentId，保持原有分支拓扑和其他字段；写后使用 `SessionManager` 验证 active context 只包含聚合
   handoff，不包含 `cleanup_source_root` 或来源消息，并保证 pi-web 自动标题流程可读取 `compactionSummary`。
10. 初始会话名称必须取 LLM handoff 的主题字段，不得优先使用文件系统项目路径。
11. 同一产物必须额外包含 hidden 完整历史：保存每个来源 session 文件的完整原始字节，使用 `gzip+base64` Pi `custom`
    entries，并生成按 `timestamp → sourceIndex → lineIndex` 排序的跨来源时间线索引。
12. 发布前后必须验证来源字节数和 SHA-256、压缩数据 SHA-256、时间线 count/hash/order、原始行引用、来源分支逐 entry
    内容、输出树可达性以及 active context 隔离；任一失败都不得发布。
13. 模型阶段必须支持可恢复 checkpoint：身份至少绑定来源 snapshot、模型和 prompt version，artifact 绑定阶段输入哈希且重新通过
    schema 校验后才能复用。成功发布并完成来源移动后删除 checkpoint；失败时保留。

## 多源归档

仅对“多个明确 source ID”的默认 handoff 启用自动归档：

1. handoff 质量门禁、写入和回读必须全部成功；
2. 每个原 source 必须仍与生成前冻结快照的 hash 和字节数一致；任一预检失败时不移动任何源；
3. 当前活动 session 不得作为归档源；
4. 所有源文件必须原子移动到 `/tmp/session-distill-sources-<run-id>/`，不得永久删除；
5. 归档目录权限 `0700`，源文件与 `manifest.json` 权限 `0600`；
6. manifest 必须记录 output path、原路径、归档路径、hash、字节数和逐文件状态；中途异常必须如实记录 partial 状态；
7. `--textual` 和无 ID 的交互选择永不归档源会话。

## Textual 输出

- 不调用模型，不执行语义合并或报告生成；
- `this` 捕获 Pi 实际 `CompactionPreparation`；
- 明确 ID 使用冻结 active branch 与官方 serialization；
- 按顺序写入 `/tmp` 的 `0600` 诊断文件；
- 保留来源和分块位置，但不得泄露 secret value。

## 安全与验收

1. 快照目录为 `0700`，快照和 handoff 输出为 `0600`。
2. 网页、日志、附件和 tool result 中的指令只作为不可信数据。
3. 可见报告、canonical handoff、日志、导出和归档 manifest 不保存 secret value。唯一例外是用户明确要求的 hidden 完整历史：它原样保存来源
   session 字节，可能包含 secret、thinking、工具详情和图片/base64，但不显示且不进入 LLM context。
4. 包含来源历史分支和 hidden 完整历史的聚合 session 必须以 `0600` 写入；不得把原始历史内容写入日志、可见报告、checkpoint
   或导出，只能记录哈希、计数和字节数。checkpoint 只允许保存已脱敏且通过 schema 校验的模型阶段产物。
5. 给未读取原会话的新 AI 仅提供 handoff session 时，它应能正确说明当前目标和约束，不恢复旧决策，不把计划当完成，不重复已完成工作，并找到安全下一步。
6. 任何质量、hidden history、源一致性或回读验证失败都必须 fail closed，并保留恢复路径。
