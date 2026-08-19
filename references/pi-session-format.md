# Pi v3 Session Format — cleanup 所需部分

本文件只记录 session-cleanup 使用的稳定边界。

## 官方事实

当前 upstream Pi session version 为 v3，session entry 使用 `id/parentId` 形成树。

`CompactionEntry` 当前包含：

```ts
interface CompactionEntry {
  type: "compaction";
  id: string;
  parentId: string | null;
  timestamp: string;
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
  fromHook?: boolean;
}
```

当前 `buildContextEntries()` 的语义：

1. 取当前 leaf path；
2. 找最新 compaction；
3. context 从 compaction summary 开始；
4. 加入 compaction 前从 `firstKeptEntryId` 起保留的 entries；
5. 加入 compaction 后 entries。

`custom`：用于 extension state，不进入 LLM context。

`custom_message`：进入 LLM context，并可通过 `display` 控制 TUI 显示。

## 本扩展的兼容策略

v3 writer **不手写 compaction**。

使用：

```text
custom_message / cleanup_text
custom / cleanup_manifest
custom / cleanup_ir
```

这样不依赖 `firstKeptEntryId` / retained-tail 变体。

## 参考源

- Pi upstream session manager:
  `https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts`
- Session format docs:
  `https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md`
- Extension docs:
  `https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md`
