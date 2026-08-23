import assert from "node:assert/strict";
import test from "node:test";
import {preserveActiveHardConstraints, reportTitle} from "../handoff.ts";

const hardConstraint = {
    statement: "所有后续操作必须从 Token Harbor 目录执行，并优先使用目录内脚本",
    level: "hard",
    status: "active",
    supersedes: null,
    evidenceRefs: ["source#chunk-1"],
    confidence: 1,
};

test("有证据的概括性 supersedes 不会恢复 previous handoff 旧约束", () => {
    const previous = {
        constraints: [{...hardConstraint, id: "CON-old"}],
    };
    const replacement = {
        ...hardConstraint,
        id: "CON-current",
        statement: "从仓库根目录执行 Token Harbor canonical 命令",
        supersedes: "从 Token Harbor 目录执行",
        evidenceRefs: ["source#chunk-2"],
    };
    const result = preserveActiveHardConstraints({constraints: [replacement]}, [previous]);
    assert.deepEqual(result.constraints, [replacement]);
});

test("聚合会话标题优先使用 LLM 主题而不是项目路径", () => {
    const report = {
        scope: {
            project: "/Users/xr/IDEA.localized/playwright/Grok", topic: "Token Harbor、Grok 与 CPAMC 状态交接",
        },
    };
    assert.equal(reportTitle(report), "Token Harbor、Grok 与 CPAMC 状态交接");
});
