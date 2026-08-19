# Validation Report — v4.0.0

## Automated tests

Command:

```bash
npm test
```

Result in the build environment:

```text
36 tests
36 pass
0 fail
```

Coverage includes:

- v3 snapshot-first source preservation;
- switch cancellation and source-change warning semantics;
- `switchSession(..., {withSession})` stale-context lifecycle regression;
- textual thinking/toolCall projection;
- textual tool result policies;
- exact/overlap/conservative near dedup;
- textual hidden IR idempotence;
- 0600 atomic output / 0700 snapshot directory;
- handoff fragment coverage-local evidence refs;
- canonical handoff stable IDs and normalized semantic hash;
- deterministic handoff Markdown headings;
- verifier `pass` consistency with score gate;
- handoff writer: visible Markdown once + hidden canonical JSON once;
- handoff writer rejects accidental `cleanup_ir` mixing;
- prompt-injection labeling.

## Syntax checks

```bash
node --experimental-strip-types --check index.ts
node --experimental-strip-types --check handoff.ts
node --experimental-strip-types --check session-writer.ts
```

All passed in the build environment.

## JSON Schema check

`schemas/agent-handoff-v1.schema.json` parses as valid JSON.

## Important limitation

The build container does **not** have the real `pi` CLI or the installed `@earendil-works/pi-coding-agent` runtime package, so this environment cannot execute a real LLM handoff run or real TUI `switchSession` smoke test.

The integration layer is derived from the already working v3.0.3 extension API usage and retains its snapshot/switch lifecycle code. Production validation on the target Mac should run:

```bash
cd ~/.pi/agent/extensions/session-cleanup
npm test
pi -e ~/.pi/agent/extensions/session-cleanup/index.ts --list-models
```

Then use a disposable or known session to perform:

```text
/cleanup this
```

Expected behavior:

1. no confirm modal;
2. UI says handoff generation started;
3. model performs extraction/consolidation/verifier calls;
4. output session title begins `Handoff ·`;
5. visible body is structured Markdown, not `用户：/助手：` transcript;
6. session JSONL contains exactly one hidden `customType=cleanup_handoff`;
7. re-running `/cleanup this` without new messages keeps the same semantic report ID/hash;
8. adding new messages then re-cleaning updates state using old canonical JSON + new tail.
