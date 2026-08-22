# Pi Session Distill

为 Pi 会话提供两种明确行为：单会话原地 native compaction，以及多会话 Agent State Handoff 聚合。

## 行为矩阵

| 命令 | 结果 | 源会话处理 |
|---|---|---|
| `/cleanup this` | 在当前会话原地追加 native `CompactionEntry` | 保留 |
| `/cleanup <session-id>` | 在指定历史会话原地追加 native `CompactionEntry` | 保留 |
| `/cleanup <id> <id> [...]` | 生成并验证一个新的聚合 handoff session | 成功发布且源未变化后，移动到 `/tmp/session-distill-sources-<run-id>/` |
| `/cleanup` | 交互选择并生成 handoff | 始终保留 |
| 任意 `--textual` 调用 | 仅写入 `/tmp/session-distill-textual-*.md` | 始终保留且不修改 |

`/cleanup this` 使用 Pi 实际的 `CompactionPreparation`。单个明确 ID 使用 Pi 官方 `prepareCompaction` 对冻结副本计算 cut point，再将经过回读验证的 `CompactionEntry` 追加到原会话；写入前会创建 `0700/0600` 安全快照。

多个明确 ID 使用冻结 active branch、当前模型、canonical handoff 和质量 verifier。只有质量门禁、原子写入、回读以及全部源文件一致性检查都通过后，才会原子移动源文件。归档目录为 `0700`，文件和 `manifest.json` 为 `0600`；不永久删除源文件。失败时不发布无效结果，也不会把尚未移动的源文件标记为成功。

## 接管 Pi 压缩事件

无需额外配置。扩展加载后会自动注册 Pi 的 `session_before_compact` hook，点击压缩、执行 `/compact` 或触发自动压缩时都会由 `session-distill` 接管摘要生成；失败时回退到 Pi 原生摘要。这些入口继续使用 Pi 当前的压缩设置；显式执行 `/cleanup this` 时会进行 full-span compaction，将近期原文保留窗口设为 `0`，只保留 Pi 要求的最小结构边界。

## Textual 检查

```text
/cleanup this --textual
/cleanup <session-id> [session-id...] --textual
```

`--textual` 不调用清洗模型、不创建或切换 session，也不修改或移动任何源 session。`this` 内容来自 Pi 实际 `CompactionPreparation`；明确 ID 使用冻结 active branch 和 Pi 官方 `convertToLlm()` + `serializeConversation()` 生成离线诊断输入。

## Handoff 输入与输出

多会话 handoff：

- 冻结每个源 session 的 active branch；
- 复用已有 hidden canonical handoff，只处理其后的真实 tail；
- 在交给模型前脱敏，并把源内容视为不可信数据；
- 生成 deterministic Markdown、hidden canonical handoff 和来源 manifest；
- verifier 未通过时拒绝发布，不降级为低质量 textual 结果。

## 安装

推荐方式(需要已安装 Pi):

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
