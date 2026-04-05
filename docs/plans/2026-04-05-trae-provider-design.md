# Trae Provider Design

**Date:** 2026-04-05

**Status:** Approved

**Goal**

Add Trae CLI as a first-class provider in Clowder AI, exposed as `Trae (client-auth)`, with session persistence and JSON-first result ingestion.

## Scope

- Add a new `trae` provider/client across shared types, backend config schemas, runtime registry, and Hub UI.
- Add a dedicated `TraeAgentService`.
- Treat Trae as `client-auth`, not API-key auth and not official OAuth.
- Use Trae's `--json` output as the primary integration path.
- Do not add a raw-text execution mode in V1.

## Non-Goals

- No API-key mode for Trae in V1.
- No automatic mutation of user global Trae runtime config files.
- No attempt to force live token-by-token streaming in V1.
- No speculative retry logic for Trae-specific session errors until real samples exist.

## Key Decisions

1. `Trae` is a first-class provider, not a shim on top of Claude/Codex.
2. Hub exposes `Trae (client-auth)` as a builtin account option.
3. `TraeAgentService` is JSON-first. The service parses Trae's final JSON envelope and converts it into Clowder agent messages.
4. V1 does not implement a raw-text primary path.
5. V1 does not pass an aggressive `--query-timeout`; Clowder's outer timeout and liveness policy remain authoritative.
6. Global config files such as `~/.trae/trae_cli.yaml` must not be modified automatically.

## Observed CLI Behavior

Validated locally on `trae-cli 0.120.1`:

- `trae-cli -p --json "<prompt>"` returns a structured JSON object on success.
- The JSON envelope includes:
  - `session_id`
  - `agent_states[].messages`
  - tool calls and tool results
  - top-level `message.content`
  - usage metadata
- `trae-cli -p "<prompt>"` returns plain final text.
- Passing a very short `--query-timeout 5s` can trigger a Trae-side panic when the query does not finish in time. This is treated as a Trae CLI robustness issue, not a JSON-format issue.

## Architecture

### 1. Type Surface

Add `trae` to the relevant type and schema surfaces:

- shared provider/client enums
- backend cat config schemas
- account resolver builtin-client mapping
- Hub provider profile types and fallback builtin profile list
- cat editor client selection and validation

### 2. Account Model

Trae is modeled as a builtin `client-auth` account:

- no API key form in V1
- not mapped onto existing `openai`/`anthropic` builtin identities
- bound explicitly to Trae members
- validation rejects cross-binding to non-Trae builtin accounts

### 3. Runtime Service

`TraeAgentService` owns Trae-specific invocation behavior:

- command: `trae-cli`
- new session: `-p <prompt> --json --session-id <uuid>`
- resume: `-p <prompt> --json --resume <sessionId>`
- model override: `-c model.name=<model>`
- system prompt handling: prepend into prompt content because Trae has no dedicated system-prompt flag

### 4. Session Strategy

Clowder generates the session id for new Trae sessions and yields `session_init` immediately before invoking the CLI. This avoids depending on incremental session metadata from stdout.

### 5. Timeout Strategy

V1 avoids a short Trae-internal `--query-timeout`. Timeout ownership remains in Clowder:

- outer CLI timeout
- liveness probe
- invocation cancellation

If Trae-internal timeout is introduced later, it must be conservative and configurable.

## Data Flow

1. User or Hub selects a Trae-backed member.
2. Cat config resolves to `provider=trae`.
3. Account resolution validates the bound account is a Trae builtin account.
4. `invoke-single-cat` prepares the prompt and passes control to `TraeAgentService`.
5. `TraeAgentService` runs `trae-cli ... --json ...`.
6. On process completion, the JSON payload is parsed and transformed into:
   - `session_init`
   - `tool_use`
   - `tool_result`
   - final `text`
   - `done`
7. Usage metadata is attached when present.

## Error Handling

- Missing CLI: return a clear `Trae CLI not found` error.
- Invalid binding: fail before invoking the CLI.
- Invalid JSON payload: surface a provider-specific parse error with diagnostics.
- Non-zero exit or Trae panic: surface stderr summary as a Trae CLI error.
- Resume failure: surface transparently in V1; no auto-retry without verified provider-specific patterns.

## MCP and Tooling

V1 does not automatically rewrite Trae global runtime config. Tool integration must stay project-scoped or be added through an explicit supported mechanism that does not mutate user global config behind the user's back.

Because Trae's JSON output already includes tool calls and tool results, Clowder can still reconstruct structured audit events after execution even without live streaming.

## Tradeoff

JSON-first integration is sufficient for correctness and structured replay, but it does not provide true real-time token streaming in V1. The accepted tradeoff is:

- correctness and structured data first
- streaming parity later, only if Trae exposes a reliable incremental event protocol

## Testing Strategy

### Backend

- type/schema coverage for `trae`
- account resolver coverage for builtin Trae binding
- `TraeAgentService` tests for:
  - args construction
  - session id generation
  - JSON parsing
  - message transformation
  - error propagation
- runtime registry wiring tests

### Frontend

- Hub shows `Trae (client-auth)`
- member editor can select Trae
- invalid non-Trae bindings are rejected

### Integration

- successful JSON parse from a representative Trae payload fixture
- structured replay includes tool call/result and final assistant content

## Review Plan

Implementation will be done locally first, then reviewed by `@gpt` before closeout.
