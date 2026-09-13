import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {SessionManager} from "@earendil-works/pi-coding-agent";
import {listCleanupSessions} from "../host.ts";

test("会话发现包含宿主自定义 session-dir 的历史会话", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "distill-custom-sessions-"));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    const manager = SessionManager.create(directory, directory);
    manager.appendMessage({role: "user", content: "custom-directory", timestamp: 1});
    manager.appendMessage({role: "assistant", content: [{type: "text", text: "saved"}], timestamp: 2});
    const sessions = await listCleanupSessions({cwd: directory, sessionManager: manager});
    assert.equal(sessions.filter((session) => session.id === manager.getSessionId()).length, 1);
});
