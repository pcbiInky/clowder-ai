# Trae Provider Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `trae` as a first-class Clowder provider backed by `trae-cli --json`, exposed in Hub as `Trae (client-auth)`, with account validation, runtime invocation, and frontend editing support.

**Architecture:** Extend the shared/backend/frontend provider surface so `trae` behaves like `dare` and `opencode` at the account-binding layer, but uses its own `TraeAgentService` at runtime. The service should run `trae-cli -p --json`, generate or resume session ids from Clowder, parse Trae's final JSON envelope, and replay it into Clowder `session_init` / `tool_use` / `tool_result` / `text` / `done` events.

**Tech Stack:** TypeScript, Node.js, Fastify, Zod, Vitest, Node test runner, `trae-cli`

---

### Task 1: Extend provider and builtin-account type surfaces

**Files:**
- Modify: `packages/shared/src/types/cat.ts`
- Modify: `packages/shared/src/types/cat-breed.ts`
- Modify: `packages/api/src/config/account-resolver.ts`
- Modify: `packages/api/src/config/cat-config-loader.ts`
- Modify: `packages/api/src/config/cat-catalog-store.ts`
- Modify: `packages/web/src/components/hub-provider-profiles.types.ts`
- Modify: `packages/web/src/components/hub-cat-editor.model.ts`
- Modify: `packages/web/src/components/hub-provider-profiles.view.ts`
- Modify: `packages/web/src/components/hub-quota-pools.ts`
- Test: `packages/api/test/account-resolver.test.js`

**Step 1: Write the failing tests**

Add focused assertions that fail until `trae` exists everywhere the builtin-client union is used:

```js
it('resolveBuiltinClientForProvider returns trae for trae provider', async () => {
  const { resolveBuiltinClientForProvider, builtinAccountIdForClient, resolveByAccountRef } = await import(
    `../dist/config/account-resolver.js?t=${Date.now()}-trae`
  );

  await writeCatalog({
    trae: {
      authType: 'oauth',
      protocol: 'openai',
      displayName: 'Trae (client-auth)',
      models: ['GLM-5'],
    },
  });

  assert.equal(resolveBuiltinClientForProvider('trae'), 'trae');
  assert.equal(builtinAccountIdForClient('trae'), 'trae');

  const profile = resolveByAccountRef(projectRoot, 'trae');
  assert.ok(profile);
  assert.equal(profile.client, 'trae');
  assert.equal(profile.protocol, 'openai');
});
```

**Step 2: Run the test to verify it fails**

Run:

```bash
pnpm --filter @cat-cafe/api run build
cd packages/api && CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --test test/account-resolver.test.js --test-name-pattern trae
```

Expected: build or test failure mentioning unknown provider/client `trae`.

**Step 3: Write the minimal implementation**

Update every provider/builtin union and fallback map consistently:

```ts
export type CatProvider =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'dare'
  | 'trae'
  | 'antigravity'
  | 'opencode'
  | 'a2a';

export type BuiltinAccountClient =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'dare'
  | 'trae'
  | 'opencode';
```

Apply the same addition to:

- `resolveBuiltinClientForProvider`
- `LEGACY_BUILTIN_IDS`
- `BUILTIN_ACCOUNT_MAP`
- `normalizeProtocol` with `trae -> openai`
- `providerToBootstrapClient`
- Hub fallback builtin profiles, labels, builtin ids, and client options

Use:

- builtin id: `trae`
- display name: `Trae (client-auth)`
- default CLI command later in routes: `trae-cli`
- protocol for builtin account modeling: `openai`

**Step 4: Run the test to verify it passes**

Run:

```bash
pnpm --filter @cat-cafe/api run build
cd packages/api && CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --test test/account-resolver.test.js --test-name-pattern trae
```

Expected: PASS for the new `trae` resolver coverage.

**Step 5: Commit**

```bash
git add packages/shared/src/types/cat.ts packages/shared/src/types/cat-breed.ts packages/api/src/config/account-resolver.ts packages/api/src/config/cat-config-loader.ts packages/api/src/config/cat-catalog-store.ts packages/web/src/components/hub-provider-profiles.types.ts packages/web/src/components/hub-cat-editor.model.ts packages/web/src/components/hub-provider-profiles.view.ts packages/web/src/components/hub-quota-pools.ts packages/api/test/account-resolver.test.js
git commit -m "feat: add trae provider type surfaces [宪宪/gpt-5.4🐾]"
```

### Task 2: Wire Trae into provider-profile and cat CRUD validation

**Files:**
- Modify: `packages/api/src/routes/provider-profiles.ts`
- Modify: `packages/api/src/routes/cats.ts`
- Modify: `packages/api/test/provider-profiles-route.test.js`
- Modify: `packages/api/test/cats-routes-runtime-crud.test.js`
- Modify: `packages/web/src/components/__tests__/cat-cafe-hub-provider-profiles-tab.test.ts`
- Modify: `packages/web/src/components/__tests__/hub-cat-editor.test.tsx`
- Modify: `packages/web/src/components/__tests__/hub-provider-profile-item.test.tsx`

**Step 1: Write the failing tests**

Add coverage for these behaviors:

```js
it('lists Trae builtin accounts as Trae (client-auth)', async () => {
  // GET /api/provider-profiles should preserve a builtin trae account
});

it('POST /api/cats accepts trae members bound to trae builtin account', async () => {
  // client: 'trae', accountRef: 'trae', defaultModel: 'GLM-5'
});

it('POST /api/cats rejects trae members bound to a non-trae builtin account', async () => {
  // client: 'trae', accountRef: 'codex' -> incompatible with client "trae"
});
```

Add matching frontend assertions:

- Hub fallback cards include `Trae (client-auth)`
- Hub cat editor exposes `Trae` in the client picker
- Filtering accounts for `trae` returns the Trae builtin profile plus API-key profiles only if that is still allowed by the binding rules

**Step 2: Run the tests to verify they fail**

Run:

```bash
pnpm --filter @cat-cafe/api run build
cd packages/api && CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --test test/provider-profiles-route.test.js test/cats-routes-runtime-crud.test.js --test-name-pattern trae
pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/cat-cafe-hub-provider-profiles-tab.test.ts src/components/__tests__/hub-cat-editor.test.tsx src/components/__tests__/hub-provider-profile-item.test.tsx -t trae
```

Expected: failures because `trae` is not yet accepted by the route schemas and fallback UI.

**Step 3: Write the minimal implementation**

Make the CRUD and display layers agree on Trae semantics:

```ts
const NON_STANDARD_BUILTIN_CLIENTS = new Set(['dare', 'trae', 'opencode']);

function defaultCliForClient(client: CatProvider) {
  switch (client) {
    case 'trae':
      return { command: 'trae-cli', outputFormat: 'json' };
  }
}
```

Apply the same semantics to:

- `clientSchema` and cat create/update validation
- builtin profile `client` inference in provider profiles
- builtin display names in Hub fallback data
- frontend `ClientValue`, `CLIENT_OPTIONS`, `builtinAccountIdForClient`, and `legacyProfileClient`

Keep the binding rule strict:

- builtin `trae` account is only valid for provider `trae`
- Trae continues to model as `protocol: 'openai'`
- no special API-key form or Trae-only credentials in this task

**Step 4: Run the tests to verify they pass**

Run:

```bash
pnpm --filter @cat-cafe/api run build
cd packages/api && CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --test test/provider-profiles-route.test.js test/cats-routes-runtime-crud.test.js --test-name-pattern trae
pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/cat-cafe-hub-provider-profiles-tab.test.ts src/components/__tests__/hub-cat-editor.test.tsx src/components/__tests__/hub-provider-profile-item.test.tsx -t trae
```

Expected: PASS for all Trae-specific CRUD and Hub UI coverage.

**Step 5: Commit**

```bash
git add packages/api/src/routes/provider-profiles.ts packages/api/src/routes/cats.ts packages/api/test/provider-profiles-route.test.js packages/api/test/cats-routes-runtime-crud.test.js packages/web/src/components/__tests__/cat-cafe-hub-provider-profiles-tab.test.ts packages/web/src/components/__tests__/hub-cat-editor.test.tsx packages/web/src/components/__tests__/hub-provider-profile-item.test.tsx
git commit -m "feat: wire trae into hub bindings [宪宪/gpt-5.4🐾]"
```

### Task 3: Add TraeAgentService tests and a representative JSON fixture

**Files:**
- Create: `packages/api/test/trae-agent-service.test.js`
- Create: `packages/api/test/helpers/trae-test-helpers.js`
- Modify: `packages/api/test/helpers/fake-cli-path.js`

**Step 1: Write the failing tests**

Build a fixture that matches the locally verified JSON structure and assert the replay contract:

```js
const SUCCESS_PAYLOAD = {
  session_id: 'trae-session-1',
  agent_states: [
    {
      messages: [
        { role: 'user', content: 'Reply with exactly hi' },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_1',
              function: { name: 'Read', arguments: '{"file_path":"AGENTS.md"}' },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: 'AGENTS.md contents',
        },
      ],
    },
  ],
  message: { content: 'hi' },
  response_meta: { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
};
```

Cover:

- new-session args use `-p`, `--json`, `--session-id`
- resume args use `--resume`
- model override becomes `-c model.name=<model>`
- JSON payload yields exactly one `session_init`
- assistant tool call becomes `tool_use`
- tool reply becomes `tool_result`
- final assistant content becomes `text`
- malformed JSON and non-zero exit become provider-specific `error`

**Step 2: Run the test to verify it fails**

Run:

```bash
pnpm --filter @cat-cafe/api run build
cd packages/api && CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --test test/trae-agent-service.test.js
```

Expected: module-not-found failure for `TraeAgentService` and/or missing fake `trae-cli`.

**Step 3: Write the minimal implementation scaffolding**

Prepare the test harness first:

- make `ensureFakeCliOnPath('trae-cli')` work
- add a helper that can stream one JSON blob to stdout and then emit process exit

Keep the fixture helper small:

```js
export function emitTraeJson(proc, payload) {
  proc.stdout.write(JSON.stringify(payload));
  proc.stdout.end();
  process.nextTick(() => proc._emitter.emit('exit', 0, null));
}
```

**Step 4: Run the test again to verify it still fails for the real missing logic**

Run:

```bash
pnpm --filter @cat-cafe/api run build
cd packages/api && CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --test test/trae-agent-service.test.js
```

Expected: assertion failures on message transformation and CLI args, not test harness setup.

**Step 5: Commit**

```bash
git add packages/api/test/trae-agent-service.test.js packages/api/test/helpers/trae-test-helpers.js packages/api/test/helpers/fake-cli-path.js
git commit -m "test: add trae agent service coverage [宪宪/gpt-5.4🐾]"
```

### Task 4: Implement TraeAgentService and register it in the runtime

**Files:**
- Create: `packages/api/src/domains/cats/services/agents/providers/TraeAgentService.ts`
- Modify: `packages/api/src/domains/cats/services/index.ts`
- Modify: `packages/api/src/index.ts`
- Modify: `packages/api/src/domains/cats/services/agents/invocation/invoke-single-cat.ts`
- Modify: `packages/api/test/invoke-single-cat.test.js`
- Test: `packages/api/test/trae-agent-service.test.js`

**Step 1: Write the failing runtime wiring tests**

Add a targeted runtime test that proves a `trae` cat selects `TraeAgentService` and passes the right callback/model/session data:

```js
it('routes trae cats through TraeAgentService with openai-style model override', async () => {
  // expect CAT_CAFE_OPENAI_MODEL_OVERRIDE or equivalent callback env to reach the service
});
```

If `invoke-single-cat.test.js` is too broad, add a narrow assertion in the existing provider-switch coverage instead of duplicating end-to-end routing.

**Step 2: Run the tests to verify they fail**

Run:

```bash
pnpm --filter @cat-cafe/api run build
cd packages/api && CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --test test/trae-agent-service.test.js test/invoke-single-cat.test.js --test-name-pattern trae
```

Expected: failures because the provider switch and service export are still missing.

**Step 3: Write the minimal implementation**

Implement `TraeAgentService` in the same style as the other CLI-backed providers:

```ts
export class TraeAgentService implements AgentService {
  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const effectivePrompt = options?.systemPrompt ? `${options.systemPrompt}\n\n${prompt}` : prompt;
    const effectiveModel = options?.callbackEnv?.CAT_CAFE_OPENAI_MODEL_OVERRIDE ?? this.model;
    const sessionId = options?.sessionId ?? randomUUID();
    const args = options?.sessionId
      ? ['-p', '--json', '--resume', options.sessionId]
      : ['-p', '--json', '--session-id', sessionId];

    args.push('-c', `model.name=${effectiveModel}`, effectivePrompt);
  }
}
```

Implementation requirements:

- resolve the binary with `resolveCliCommand('trae-cli')`
- do not pass a short `--query-timeout`
- parse one final JSON blob from stdout, not NDJSON
- set `metadata.provider = 'trae'`
- derive usage from `response_meta.usage`
- emit `session_init` immediately from the known session id if needed, but do not duplicate it when the JSON echoes the same id
- map tool calls from `agent_states[].messages`
- stringify non-string tool outputs conservatively for `tool_result`
- surface invalid JSON as `Trae CLI returned invalid JSON`

Register the service and provider switch:

- export from `packages/api/src/domains/cats/services/index.ts`
- add `case 'trae': service = new TraeAgentService({ catId })` in `packages/api/src/index.ts`
- in `invoke-single-cat.ts`, let Trae inherit the openai-style model override path without pretending it is Codex auth

**Step 4: Run the tests to verify they pass**

Run:

```bash
pnpm --filter @cat-cafe/api run build
cd packages/api && CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --test test/trae-agent-service.test.js test/invoke-single-cat.test.js --test-name-pattern trae
```

Expected: PASS for Trae service replay and provider registration.

**Step 5: Commit**

```bash
git add packages/api/src/domains/cats/services/agents/providers/TraeAgentService.ts packages/api/src/domains/cats/services/index.ts packages/api/src/index.ts packages/api/src/domains/cats/services/agents/invocation/invoke-single-cat.ts packages/api/test/invoke-single-cat.test.js packages/api/test/trae-agent-service.test.js
git commit -m "feat: add trae agent runtime [宪宪/gpt-5.4🐾]"
```

### Task 5: Finalize frontend editor behavior and fallback account UX

**Files:**
- Modify: `packages/web/src/components/HubProviderProfilesTab.tsx`
- Modify: `packages/web/src/components/HubProviderProfileItem.tsx`
- Modify: `packages/web/src/components/HubCatEditor.tsx`
- Modify: `packages/web/src/components/__tests__/cat-cafe-hub-provider-profiles-tab.test.ts`
- Modify: `packages/web/src/components/__tests__/hub-provider-profile-item.test.tsx`
- Modify: `packages/web/src/components/__tests__/hub-cat-editor.test.tsx`

**Step 1: Write the failing UI assertions**

Focus on the actual user-visible behavior:

- fallback provider profile list shows `Trae (client-auth)`
- builtin Trae card is read-only like Dare/OpenCode, not an API-key form
- Hub cat editor can save a Trae member using `client: 'trae'` and `accountRef: 'trae'`

Example payload expectation:

```ts
expect(payload).toMatchObject({
  provider: 'trae',
  accountRef: 'trae',
  defaultModel: 'GLM-5',
  cli: { command: 'trae-cli', outputFormat: 'json' },
});
```

**Step 2: Run the tests to verify they fail**

Run:

```bash
pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/cat-cafe-hub-provider-profiles-tab.test.ts src/components/__tests__/hub-provider-profile-item.test.tsx src/components/__tests__/hub-cat-editor.test.tsx -t trae
```

Expected: failures in labels, client options, or generated payload.

**Step 3: Write the minimal implementation**

Keep Trae aligned with Dare/OpenCode behavior:

- builtin card label: `Trae (client-auth)`
- no verify button or extra binding controls
- client picker label: `Trae`
- payload generation uses `command: 'trae-cli'` and `outputFormat: 'json'`

Do not add UI for custom Trae secrets or global config mutation.

**Step 4: Run the tests to verify they pass**

Run:

```bash
pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/cat-cafe-hub-provider-profiles-tab.test.ts src/components/__tests__/hub-provider-profile-item.test.tsx src/components/__tests__/hub-cat-editor.test.tsx -t trae
```

Expected: PASS for Trae-specific Hub flows.

**Step 5: Commit**

```bash
git add packages/web/src/components/HubProviderProfilesTab.tsx packages/web/src/components/HubProviderProfileItem.tsx packages/web/src/components/HubCatEditor.tsx packages/web/src/components/__tests__/cat-cafe-hub-provider-profiles-tab.test.ts packages/web/src/components/__tests__/hub-provider-profile-item.test.tsx packages/web/src/components/__tests__/hub-cat-editor.test.tsx
git commit -m "feat: expose trae in hub ui [宪宪/gpt-5.4🐾]"
```

### Task 6: Full verification and review handoff

**Files:**
- Modify as needed from previous tasks only
- Review artifact: working tree diff and test logs

**Step 1: Run the focused backend verification**

Run:

```bash
pnpm --filter @cat-cafe/api run build
cd packages/api && CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --test test/account-resolver.test.js test/provider-profiles-route.test.js test/cats-routes-runtime-crud.test.js test/trae-agent-service.test.js test/invoke-single-cat.test.js
```

Expected: PASS with no Trae regressions.

**Step 2: Run the focused frontend verification**

Run:

```bash
pnpm --filter @cat-cafe/web exec vitest run src/components/__tests__/cat-cafe-hub-provider-profiles-tab.test.ts src/components/__tests__/hub-provider-profile-item.test.tsx src/components/__tests__/hub-cat-editor.test.tsx
pnpm --filter @cat-cafe/web run build
```

Expected: PASS for targeted UI tests and a successful Next build.

**Step 3: Run formatting/lint only if the changed files require it**

Run:

```bash
pnpm check:fix
pnpm --filter @cat-cafe/api run lint
```

Expected: no new lint or type errors in changed surfaces.

**Step 4: Inspect the diff before review**

Run:

```bash
git status --short
git diff -- packages/shared/src/types/cat.ts packages/shared/src/types/cat-breed.ts packages/api/src/config/account-resolver.ts packages/api/src/config/cat-config-loader.ts packages/api/src/config/cat-catalog-store.ts packages/api/src/routes/provider-profiles.ts packages/api/src/routes/cats.ts packages/api/src/domains/cats/services/agents/providers/TraeAgentService.ts packages/api/src/domains/cats/services/index.ts packages/api/src/index.ts packages/api/src/domains/cats/services/agents/invocation/invoke-single-cat.ts packages/api/test/account-resolver.test.js packages/api/test/provider-profiles-route.test.js packages/api/test/cats-routes-runtime-crud.test.js packages/api/test/trae-agent-service.test.js packages/api/test/invoke-single-cat.test.js packages/web/src/components/hub-provider-profiles.types.ts packages/web/src/components/hub-cat-editor.model.ts packages/web/src/components/hub-provider-profiles.view.ts packages/web/src/components/hub-quota-pools.ts packages/web/src/components/HubProviderProfilesTab.tsx packages/web/src/components/HubProviderProfileItem.tsx packages/web/src/components/HubCatEditor.tsx packages/web/src/components/__tests__/cat-cafe-hub-provider-profiles-tab.test.ts packages/web/src/components/__tests__/hub-provider-profile-item.test.tsx packages/web/src/components/__tests__/hub-cat-editor.test.tsx
```

Expected: only Trae-related files and any unavoidable formatting churn.

**Step 5: Request cross-family review**

Post a concise review request that points at the Trae design constraints and the evidence from local CLI probing:

```text
@gpt
请 review Trae provider 接入：重点看 provider/account 绑定是否干净，TraeAgentService 的 JSON 重放是否会丢 tool/result/usage，以及有没有把 client-auth 误做成 Codex OAuth 语义。
```

**Step 6: Final commit after review fixes**

```bash
git add <changed-files>
git commit -m "feat: add trae provider [宪宪/gpt-5.4🐾]"
```
