# Pi Session Distill

为 Pi 会话提供两种明确行为：单会话原地 native compaction，以及多会话 Agent State Handoff 聚合。

## 行为矩阵

| 命令                       | 结果                                                           | 源会话处理                                                            |
|----------------------------|----------------------------------------------------------------|-----------------------------------------------------------------------|
| `/cleanup this`            | 原子重写当前会话：仅显示 checkpoint，并嵌入 hidden 完整历史    | 完整原始 JSONL 进入 hidden archive，另保留恢复快照                     |
| `/cleanup <session-id>`    | 在指定历史会话原地追加 native `CompactionEntry`                | 保留                                                                  |
| `/cleanup <id> <id> [...]` | 生成并验证一个新的聚合 handoff session，并嵌入 hidden 完整历史 | 成功发布且源未变化后，移动到 `/tmp/session-distill-sources-<run-id>/` |
| `/cleanup`                 | 交互选择并生成 handoff                                         | 始终保留                                                              |
| 任意 `--textual` 调用      | 仅写入 `/tmp/session-distill-textual-*.md`                     | 始终保留且不修改                                                      |

`/cleanup this` 在冻结副本上使用 Pi 官方 `prepareCompaction`，将完整有效上下文提炼为 active `CompactionEntry`；原 session tree 复制到 `cleanup_source_root` 非 active 分支，原始 JSONL 的精确字节同时以 hidden archive entries 嵌入同一会话，再原子替换源文件。交互模式会先把 runtime 切到冻结快照的 staging 文件，成功脱离源文件后才发布 replacement，避免刷新取消时旧 `SessionManager` 向新树追加失效 parentId。显式标题缺失时从首条用户消息生成 `session_info`。单个明确 ID 仍使用 Pi 官方 cut point，将经过回读验证的 `CompactionEntry` 追加到原会话；两条路径写入前都会创建 `0700/0600` 安全快照。

多个明确 ID 使用冻结 active branch、当前模型、canonical handoff 和质量 verifier。聚合产物是一棵真正的 Pi session
tree：每个来源完整 session tree 被复制为独立非 active 分支，聚合 handoff 以 native `CompactionEntry` 作为最后追加的 active
checkpoint。正常会话和 LLM context 只看到 handoff；pi-web“完整历史”可以展开来源分支，并可基于该 checkpoint 使用“生成标题”。会话初始名称取
LLM handoff 的主题，不使用文件系统项目路径。原始 JSONL 字节还会以 hidden Pi `custom` entries
保存并建立跨来源时间线索引。只有质量门禁、树结构、hidden history、原子写入、回读以及全部源文件一致性检查都通过后，才会把来源临时移动到
`/tmp/session-distill-sources-<run-id>/`。失败时不发布无效结果，也不移动来源。

## 接管 Pi 压缩事件

无需额外配置。扩展加载后会自动注册 Pi 的 `session_before_compact` hook，点击压缩、执行 `/compact` 或触发自动压缩时都会由
`session-distill` 接管摘要生成；失败时回退到 Pi 原生摘要。这些入口继续使用 Pi 当前的压缩设置。显式执行 `/cleanup this` 时则直接用 Pi 官方 `prepareCompaction` 进行
full-span compaction：把压缩前的整个有效会话（既有 checkpoint + 当前原始后缀）全部交给提炼模型，将近期原文保留窗口设为 `0`。写入时原子重建同一个 session：`cleanup_merge_root` 下的 active 分支仅包含 native `CompactionEntry`、标题和 hidden archive，完整原 session tree 位于 sibling 非 active 分支；普通界面和模型上下文只看到 checkpoint，“完整历史”可展开全部原始消息，同时 `cleanup_history_*` 保存可校验的精确 JSONL 字节。

## 命令行 (非交互)用法

在脚本或 CI 中，可用 `pi` 的非交互模式直接触发 `/cleanup`。两个常用形态：

```bash
# 打开指定会话,对其执行 /cleanup this(单会话原地 native compaction)
pi --session 15e1ab4f-2b8d-47c2-a1c0-f0097e18e110 "/cleanup this" --print

# ephemeral 模式(不创建/保存临时会话),对指定历史会话执行 /cleanup <session-id>
pi --no-session "/cleanup 15e1ab4f-2b8d-47c2-a1c0-f0097e18e110" --print
```

两者都会在完成写入后退出；`/cleanup` 是扩展命令，不会生成普通 Assistant 回复，因此成功时 stdout 可能为空，应以退出码和目标 session 中回读到的 `CompactionEntry` 为准。区别在于：

- `--session <id>`：载入目标会话，`/cleanup this` 针对 **当前会话**（即该 ID）原子写入单一可见 checkpoint 与 hidden 完整历史。
- `--no-session`:启动 ephemeral 临时会话,`/cleanup <session-id>` 是针对 **指定历史会话**执行同一原地
  compaction,不会保留这次的临时会话。

单会话清理 (`/cleanup this` 或 `/cleanup <session-id>`)适合这种非交互调用;多会话聚合 handoff 需要交互确认/移动源文件,建议在交互式
TUI 中使用 (或先用 `--textual` 离线检查)。

## Textual 检查

```text
/cleanup this --textual
/cleanup <session-id> [session-id...] --textual
```

`--textual` 不调用清洗模型、不创建或切换 session，也不修改或移动任何源 session。`this` 内容来自 Pi 实际
`CompactionPreparation`；明确 ID 使用冻结 active branch 和 Pi 官方 `convertToLlm()` + `serializeConversation()` 生成离线诊断输入。

## Handoff 输入与输出

多会话 handoff：

- 冻结每个源 session 的 active branch；
- 复用已有 hidden canonical handoff，只处理其后的真实 tail；
- 在交给模型前脱敏，并把源内容视为不可信数据；
- 生成 deterministic Markdown、hidden canonical handoff 和来源 manifest；
- verifier 未通过时拒绝发布，不降级为低质量 textual 结果。

## Hidden 完整历史

`/cleanup this` 产物以及任何包含至少两个来源 session 的聚合产物都包含：

- `cleanup_history_manifest`：归档范围、来源哈希、记录数和全局时间线哈希；
- `cleanup_history_source_chunk`：每个来源 session 文件的原始字节，经 `gzip+base64` 分块；
- `cleanup_history_timeline_chunk`：整个 session tree 的记录索引，按 `timestamp → sourceIndex → lineIndex` 稳定排序，并记录每一原始
  JSONL 行的 SHA-256。

写入前后都会重新拼接、解压并核对来源字节数、来源 SHA-256、压缩数据 SHA-256、时间线顺序、时间线哈希、行引用和输出树。来源 entry
的 ID/parentId 会安全重映射到聚合文件，但原有分支拓扑和其余字段保持不变。该历史不会进入 active 模型上下文，但它是
**原样本地归档**：源会话中的 Token、Cookie、thinking、工具详情、图片/base64 等也会保留。聚合 session 因此必须继续按敏感文件管理，并保持
`0600` 权限。

## 可恢复 Checkpoint

模型阶段产物保存在：

```text
~/.pi/agent/session-distill-checkpoints/<checkpoint-key>/
```

checkpoint key 由来源 snapshot SHA-256、模型和 prompt version 决定；每个 artifact 再核对阶段输入哈希。已经通过 schema
校验且输入哈希完全相同的 fragment、consolidation、review 和 repair 可在同模型、同 prompt version 下跨 append-only snapshot
变化复用。checkpoint 和 artifact 权限分别为 `0700`/`0600`，成功发布且来源移动完成后自动删除；失败时保留用于继续。来源移动
manifest 使用原子 `0600` 替换更新，完成后冻结快照自动删除。

## 安装

推荐方式 (需要已安装 Pi):

```text
pi install git:github.com/XRSec/pi-session-distill
# 或从 npm
pi install npm:pi-session-distill
```

也可以将 ZIP 解压为以下目录:

```text
~/.pi/agent/extensions/pi-session-distill/
```

目录中应直接包含 `index.ts` 和 `package.json`,不要额外嵌套一层同名目录。重启 Pi 后运行:

```text
/cleanup this
```

详细边界和验收标准见 `REQUIREMENTS.md`。
