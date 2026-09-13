import test from "node:test";
import assert from "node:assert/strict";
import {selectResultFirstRecords} from "../core.ts";

function message(role, text) {
    return {role, content: [{type: "text", text}], timestamp: Date.now()};
}

test("completed turn keeps substantive user intent beside terminal assistant result", () => {
    const selection = selectResultFirstRecords([
        message("user", "Use CPA/gpt-5.6-luna. Do not restart the app, do not overwrite the source session, and report BLOCKED instead of guessing."),
        message("assistant", "The test completed and the source session remained unchanged."),
    ]);

    assert.equal(selection.records.length, 1);
    assert.equal(selection.records[0].mode, "assistant_final");
    assert.equal(selection.records[0].userMessages.length, 1);
    assert.match(selection.records[0].userMessages[0].content[0].text, /do not restart/i);
});

test("unfinished self-describing turn still keeps substantive user constraints", () => {
    const selection = selectResultFirstRecords([
        message("user", "Inspect the state read-only. Never request sudo and do not modify security settings."),
        message("assistant", "Current state is blocked by permissions; no privileged action was taken."),
        {role: "toolResult", toolName: "diagnostic", isError: true, content: [{type: "text", text: "permission denied"}]},
    ]);

    assert.equal(selection.records.length, 1);
    assert.equal(selection.records[0].mode, "evidence_fallback");
    assert.equal(selection.records[0].userMessages.length, 1);
});

test("low-value continuation text is still dropped", () => {
    const selection = selectResultFirstRecords([
        message("user", "继续"),
        message("assistant", "The next verification completed successfully."),
    ]);

    assert.equal(selection.records.length, 1);
    assert.equal(selection.records[0].userMessages.length, 0);
});
