# `/cleanup this` 真实回归测试

## 固定基线

- 基线 session：`01a03f53-485f-7b0a-b8da-72282d0769c1`
- 名称：`cleanup synthetic: repeat → OK`
- 内容：第一条要求后续重复样本仅回复 `OK`，随后包含 1000 组短消息与 `OK`。
- 约束：基线只读。每轮必须先通过 `SessionManager.createBranchedSession()` 创建新 session，再测试新 ID。

## 一键测试

```bash
npm run smoke:cleanup
```

脚本严格执行以下顺序：

1. 查找固定基线并创建分支副本。
2. 执行 `pi --session <新会话ID> "/cleanup this" --print`。
3. 回读新会话，验证清洗前副本完整进入 hidden archive、`cleanup_source_root` 为 `display:false` 的非 active 分支，active context 仅有一条 `compactionSummary`。
4. 输出新 session ID；设置 `PI_WEB_URL` 或传入 `--base-url` 时同时输出页面链接。

需要在命令成功后打开页面时使用：

```bash
PI_WEB_URL=http://pi.xrsec.fun:29620 npm run smoke:cleanup -- --open
```

页面验收标准：普通消息视图只显示 checkpoint，不显示清洗前的 1000 组历史；“完整历史”能力不属于普通视图残留。

## 2026-08-27 结果

- 失败副本 `01a03f65-1cab-7e2c-b363-38134eceeff7` 复现 `Nothing to compact (session too small)`。原因是 Pi 在发出 `session_before_compact` 前先执行阈值判断；短文本基线虽有 2002 条消息，仍被原生阈值提前拒绝。
- 修复后副本 `01a03f67-9924-7a68-810d-4508796e6634` 使用指定 CLI，在约 25 秒内以 exit code 0 完成。
- `01a03f69-265f-7578-9d70-eacc54f9d278` 暴露了 append-only 回归：active context 虽是单一 `compactionSummary`，但 2002 条旧消息仍位于同一 active branch，Pi Web 会通过 `/context?before=...` 重新显示它们；重启服务无效。
- 修复后副本 `01a03f7d-2ca3-7b9d-8085-18bde0238a1e`：`baselinePreservedInArchive=true`、`sourceRootHidden=true`、`sourceRootActive=false`、`contextRoles=["compactionSummary"]`。
- pi-browser-harness 页面验收通过：普通视图只显示 compaction checkpoint；没有显示 `重复样本 955` 等旧消息。`Cmd+Shift+R` 强制刷新后结果不变，且页面不再请求压缩边界之前的 `/context?before=...` 历史分页。
- 分支标签最终回归副本 `01a03f9a-aa43-783c-8966-7cc9ee6077d6`：旧历史分支恢复为原始首条用户消息；最新 active compaction 分支显示 `+7 PSD M 08/26 19:45`。完整标签存于 `CompactionEntry.details.branchLabel`，不再插入伪 user message。
