import {SessionManager} from "@earendil-works/pi-coding-agent";
import * as path from "node:path";

/** Include --session-dir sessions, which are absent from Pi's global listAll(). */
export async function listCleanupSessions(ctx: any): Promise<any[]> {
    const file = ctx.sessionManager.getSessionFile();
    const directory = ctx.sessionManager.getSessionDir?.() ?? (file ? path.dirname(file) : undefined);
    const [global, local] = await Promise.all([
        SessionManager.listAll(),
        directory ? SessionManager.list(ctx.cwd, directory) : SessionManager.list(ctx.cwd),
    ]);
    return [...new Map([...global, ...local].map((session) => [path.resolve(session.path), session])).values()];
}
