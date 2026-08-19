# Pipeline

## Default handoff

```text
Resolve sessions
→ waitForIdle
→ snapshot-first (0600 files / 0700 directory)
→ open stable copy
→ active branch
→ detect previous cleanup_handoff
→ old handoff = canonical prior state
→ only extract raw tail after old handoff
→ remove thinking
→ preserve user/assistant/tool-result evidence
→ redact secrets
→ prompt-injection labeling
→ bounded chunks
→ LLM atomic extraction
→ LLM canonical consolidation
→ output secret scrub
→ independent LLM verifier
→ one targeted repair if needed
→ reject if verifier still fails
→ assemble canonical AgentHandoffReport
→ deterministic Markdown renderer
→ write new session
→ reopen / verify
→ switchSession(withSession)
```

## Textual fallback

```text
/cleanup --textual
```

Retains v3 deterministic path and hidden `cleanup_ir`.

## Capsule

```text
/cleanup --capsule
```

Retains legacy Fact Ledger → Knowledge Capsule path.
