import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {atomicWrite0600} from "./core.ts";

const CHECKPOINT_ROOT = process.env.SESSION_DISTILL_CHECKPOINT_ROOT || path.join("/tmp", "session-distill-checkpoints");

function sha256(value: string): string {
    return crypto.createHash("sha256").update(value).digest("hex");
}

export interface CleanupCheckpoint {
    key: string;
    directory: string;

    read<T>(name: string, inputHash: string, validate: (value: unknown) => T): T | undefined;

    write(name: string, inputHash: string, value: unknown): void;

    remove(): void;
}

interface CheckpointIdentity {
    schemaVersion: 1;
    sourceSnapshots: Array<{ sourceId: string; sha256: string; bytes: number }>;
    model: string;
    promptVersion: string;
}

function artifactPath(directory: string, name: string, inputHash?: string): string {
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error(`checkpoint artifact 名称无效: ${name}`);
    const suffix = inputHash ? `-${inputHash.slice(0, 20)}` : "";
    return path.join(directory, `${name}${suffix}.json`);
}

export function openCleanupCheckpoint(options: {
    sourceSnapshots: CheckpointIdentity["sourceSnapshots"];
    model: string;
    promptVersion: string;
}): CleanupCheckpoint {
    const identity: CheckpointIdentity = {
        schemaVersion: 1,
        sourceSnapshots: options.sourceSnapshots,
        model: options.model,
        promptVersion: options.promptVersion,
    };
    const key = sha256(JSON.stringify(identity));
    fs.mkdirSync(CHECKPOINT_ROOT, {recursive: true, mode: 0o700});
    fs.chmodSync(CHECKPOINT_ROOT, 0o700);
    const directory = path.join(CHECKPOINT_ROOT, key);
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});
    fs.chmodSync(directory, 0o700);
    const statePath = path.join(directory, "state.json");
    if (fs.existsSync(statePath)) {
        let stored: { key?: unknown; identity?: unknown };
        try {
            stored = JSON.parse(fs.readFileSync(statePath, "utf8")) as { key?: unknown; identity?: unknown };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`checkpoint state 无效: ${directory} (${message})`);
        }
        if (stored.key !== key || JSON.stringify(stored.identity) !== JSON.stringify(identity)) {
            throw new Error(`checkpoint identity 不一致: ${directory}`);
        }
    } else {
        atomicWrite0600(statePath, `${JSON.stringify({
            key,
            createdAt: new Date().toISOString(),
            identity
        }, null, 2)}\n`);
    }

    const compatibleDirectories = (): Array<{ directory: string; key: string }> => {
        const result = [{directory, key}];
        for (const entry of fs.readdirSync(CHECKPOINT_ROOT, {withFileTypes: true})) {
            if (!entry.isDirectory() || entry.name === key) continue;
            try {
                const stored = JSON.parse(fs.readFileSync(path.join(CHECKPOINT_ROOT, entry.name, "state.json"), "utf8")) as {
                    key?: unknown;
                    identity?: { model?: unknown; promptVersion?: unknown }
                };
                if (stored.key !== entry.name || stored.identity?.model !== identity.model || stored.identity?.promptVersion !== identity.promptVersion) continue;
                result.push({directory: path.join(CHECKPOINT_ROOT, entry.name), key: entry.name});
            } catch {
                // Ignore unrelated or corrupt checkpoint directories.
            }
        }
        return result;
    };

    return {
        key,
        directory,
        read<T>(name: string, inputHash: string, validate: (value: unknown) => T): T | undefined {
            for (const candidate of compatibleDirectories()) {
                for (const filePath of [artifactPath(candidate.directory, name, inputHash), artifactPath(candidate.directory, name)]) {
                    if (!fs.existsSync(filePath)) continue;
                    try {
                        const envelope = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
                            schemaVersion?: unknown;
                            checkpointKey?: unknown;
                            inputHash?: unknown;
                            value?: unknown
                        };
                        if (envelope.schemaVersion !== 1 || envelope.checkpointKey !== candidate.key || envelope.inputHash !== inputHash) continue;
                        return validate(envelope.value);
                    } catch {
                        // Ignore an incompatible/corrupt artifact and try the next compatible path.
                    }
                }
            }
            return undefined;
        },
        write(name: string, inputHash: string, value: unknown): void {
            const filePath = artifactPath(directory, name, inputHash);
            if (fs.existsSync(filePath)) return;
            atomicWrite0600(filePath, `${JSON.stringify({
                schemaVersion: 1,
                checkpointKey: key,
                inputHash,
                createdAt: new Date().toISOString(),
                value,
            }, null, 2)}\n`);
        },
        remove(): void {
            fs.rmSync(directory, {recursive: true, force: true});
        },
    };
}
