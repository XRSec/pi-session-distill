# v4 Design — Agent State Handoff

## 1. Product definition

`/cleanup` 的正式产物不是“summary”，而是 **State Handoff Artifact**。

优化顺序：

```text
correctness
> current-state fidelity
> user constraints
> completion accuracy
> open blockers
> actionability
> provenance/evidence
> completeness
> compression
> prose elegance
```

## 2. Dual representation

```text
Canonical JSON (truth)
        ↓ deterministic renderer
Markdown Handoff (LLM context projection)
```

Markdown 不是二次清洗真源。二次清洗读取 hidden `cleanup_handoff` JSON。

## 3. Canonical domains

```text
scope
executiveState
runtimeEnvironment
constraints
timeline
decisions
completedWork
openItems
resources
actions
claims
evidence
provenance
security
quality
```

## 4. Evidence model

每个 raw source chunk 获得 deterministic evidence ID：

```text
coverageId → EVD-xxxxxxxxxx
```

模型 extraction/consolidation 阶段只能引用白名单 evidence refs。发布前把临时 coverage refs 映射为 deterministic evidence IDs。

## 5. Completion semantics

```text
assistant says “done” + no verification  → reported
partial implementation                 → partial
explicit failing tool/test             → failed/partial
tool/test/diff evidence supports result → verified
```

`verified` 是高价值状态，必须保守。

## 6. Supersession

同一 constraint / decision 不按“最后一句自动胜出”。

优先考虑：

```text
verified observed state
explicit final user constraint/decision
validated tool/test/diff result
assistant-reported result
assistant proposal
assistant inference
```

不同类别不相互吞并。例如：

```text
user constraint: 每节点最多 10 个账号
observed state: 当前配置仍为 2
open item: 配置尚未满足约束
```

不能错误归并成“当前已经是 10”。

## 7. Failure retention

默认删除：

- “让我检查一下”
- “现在执行”
- “worker 正在运行”
- 重复 progress narration
- 无状态价值的 tool chatter

保留/压缩：

- 导致架构方向改变的失败；
- 防止下一个 Agent 重复踩坑的失败；
- 未解决失败；
- 有唯一验证证据的失败。

## 8. Re-clean

```text
previous cleanup_handoff JSON
+
new raw tail
+
new source snapshot manifest
→ consolidate
→ verify
→ new cleanup_handoff JSON
```

无 delta 时：

```text
semantic state unchanged
reportId unchanged
normalizedContentHash unchanged
```

## 9. Publish transaction

```text
snapshot
→ generate
→ validate
→ security gate
→ verifier
→ renderer
→ write temporary/new file 0600
→ reopen/verify with SessionManager
→ switchSession(withSession)
```

任何语义质量门禁失败都不覆盖源 session。

## 10. Modes

```text
/cleanup              = semantic agent handoff
/cleanup --textual    = deterministic visible-text cleanup
/cleanup --capsule    = legacy high-compression knowledge capsule
```
