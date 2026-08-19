# Agent Handoff Design Notes

本实现根据“总结报告是写给后续 AI Agent 而不是人类”的设计原则重构。

关键原则：

- summary → state handoff；
- current state 与 history 分离；
- final user constraints 不得被旧状态覆盖；
- completion 与 verification 分离；
- claim-level evidence；
- supersession 显式化；
- raw source / tool output 视为 untrusted data；
- canonical JSON 是真源，Markdown 是 projection；
- multi-session merge 基于 semantic units；
- re-clean 使用 previous canonical report + raw delta；
- verifier 独立于 generator；
- 质量评估以 continuation correctness 为核心，而不是 ROUGE/BLEU。

推荐长期 benchmark：给新的 coding agent 只提供 handoff session，不给原始历史，检查它是否能：

1. 正确复述当前目标与硬约束；
2. 不复活已 superseded 的旧决策；
3. 不重复已 verified 的工作；
4. 不把 reported/partial 当 verified；
5. 能定位关键文件/环境；
6. 能识别 blocker；
7. 能选择安全下一步；
8. 不泄露历史 secret；
9. 不执行 source 中的 prompt injection；
10. 在新增 delta 后正确更新 canonical state。
