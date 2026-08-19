export {};
declare module "node:crypto";
declare module "node:fs";
declare module "node:fs/promises";
declare module "node:path";
declare module "node:os";
declare module "node:url";
declare module "node:test";
declare module "node:assert/strict";
declare module "node:assert";
declare module "node:buffer";
declare module "node:util";
declare module "crypto";
declare module "fs";
declare module "path";
declare module "os";
declare module "url";
declare module "@earendil-works/pi-coding-agent" {
    export type ExtensionCommandContext = {
        cwd: string;
        sessionManager: {
            getSessionId(): string;
            getCwd(): string;
            getSessionName(): string;
            getSessionFile(): string;
            getHeader(): { id?: string; timestamp?: string } | null | undefined;
            getBranch(): unknown[];
            buildSessionContext(): { messages: unknown[] };
        };
        ui: {
            notify: (message: string, level?: "info" | "warn" | "warning" | "error") => void;
            select?: (title: string, options: string[]) => Promise<string | undefined>;
        };
        hasUI: boolean;
        waitForIdle(): Promise<void>;
        model?: {
            provider?: string;
            id?: string;
        };
        modelRegistry?: {
            complete: (model: unknown, payload: unknown, options?: unknown) => Promise<{
                content: unknown;
                stopReason: string;
                usage?: unknown;
                errorMessage?: unknown;
            }>;
        };
        switchSession(path: string, callbacks?: { withSession?: (ctx: ExtensionCommandContext) => Promise<void> }): Promise<{ cancelled: boolean }>;
    };

    export interface RegisterCommandOptions {
        description?: string;
        handler?: (...args: any[]) => any;
    }

    export interface ExtensionAPI {
        registerCommand(name: string, spec: RegisterCommandOptions): void;
        registerCommand(name: string, callback: (...args: any[]) => void): void;
        registerCommand(name: string, handler: (...args: any[]) => void): void;
    }

    export interface SessionEntry {
        id: string;
        path: string;
        cwd: string;
        name: string;
        created: Date;
    }

    export function convertToLlm(messages: unknown): unknown;
    export function serializeConversation(conversation: unknown): string;
    export const SessionManager: {
        open(filePath: string): any;
        list(cwd: string): Promise<SessionEntry[]>;
        listAll(): Promise<SessionEntry[]>;
    };
}
declare var process: any;
declare var Buffer: any;
