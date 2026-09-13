import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {consolidationPrompt, validateHandoffCore} from "../handoff.ts";

const schema = JSON.parse(readFileSync(new URL("../schemas/agent-handoff-v1.schema.json", import.meta.url), "utf8"));
const scopeStatuses = schema.properties.scope.properties.status.enum;
const sideEffects = schema.$defs.action.properties.sideEffect.enum;

function core(status = "active", sideEffect = "read_only") {
    return {
        scope: {project: null, topic: "回归测试", objective: "验证枚举", status},
        executiveState: {summary: "测试", currentState: "测试", confidence: 1},
        constraints: [], timeline: [], decisions: [], completedWork: [],
        openItems: [], resources: [], claims: [],
        actions: [{title: "检查状态", priority: "P1", status: "ready", sideEffect, approvalRequired: true}],
    };
}
function validate(value) {
    return validateHandoffCore(JSON.stringify(value), "stop", new Set());
}

test("scope 合法枚举保持不变，常见进行中别名归一化为 active", () => {
    for (const status of scopeStatuses) assert.equal(validate(core(status)).scope.status, status);
    for (const status of ["in_progress", "inprogress", "ongoing"]) {
        assert.equal(validate(core(status)).scope.status, "active");
    }
    assert.equal(validate(core(null)).scope.status, "unknown");
    assert.throws(() => validate(core("invented_status")), /scope.status 非法/);
});

test("副作用合法枚举和审批标记不被降级，模糊运行时变更仍拒绝", () => {
    for (const sideEffect of sideEffects) {
        const result = validate(core("active", sideEffect));
        assert.equal(result.actions[0].sideEffect, sideEffect);
        assert.equal(result.actions[0].approvalRequired, true);
    }
    assert.throws(() => validate(core("in_progress", "runtime_state_changes")), /sideEffect 非法: runtime_state_changes/);
});

test("合并提示词列出的 scope 与副作用枚举和正式 schema 一致", () => {
    const prompt = consolidationPrompt({fragments: [], previousReports: [], allowedEvidenceRefs: []});
    const start = "Enum values (use ONLY these exact strings):\n\n";
    const enums = JSON.parse(prompt.split(start)[1].split("\n\n")[0]);
    assert.deepEqual(enums["scope.status"], scopeStatuses);
    assert.deepEqual(enums["action.sideEffect"], sideEffects);
    assert.match(prompt, /runtime state changes are not necessarily reversible/);
});
