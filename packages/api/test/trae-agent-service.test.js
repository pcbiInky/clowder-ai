import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, mock, test } from 'node:test';
import { ensureFakeCliOnPath } from './helpers/fake-cli-path.js';
import { emitTraeJson, emitTraeStdout } from './helpers/trae-test-helpers.js';

ensureFakeCliOnPath('trae-cli');

const { TraeAgentService } = await import('../dist/domains/cats/services/agents/providers/TraeAgentService.js');

function createMockProcess(exitCode = 0) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const proc = {
    stdout,
    stderr,
    pid: 42424,
    kill: mock.fn(() => {
      process.nextTick(() => {
        if (!stdout.destroyed) stdout.end();
        emitter.emit('exit', exitCode, null);
      });
      return true;
    }),
    on: (event, listener) => {
      emitter.on(event, listener);
      return proc;
    },
    once: (event, listener) => {
      emitter.once(event, listener);
      return proc;
    },
    _emitter: emitter,
  };
  return proc;
}

async function collect(iterable) {
  const messages = [];
  for await (const msg of iterable) messages.push(msg);
  return messages;
}

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
              function: {
                name: 'Read',
                arguments: '{"file_path":"AGENTS.md"}',
              },
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
  response_meta: {
    usage: {
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
    },
  },
};

const RESUME_WITH_HISTORY_PAYLOAD = {
  session_id: 'trae-session-1',
  agent_states: [
    {
      messages: [
        { role: 'user', content: 'Reply with exactly hi' },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_old',
              function: {
                name: 'Read',
                arguments: '{"file_path":"AGENTS.md"}',
              },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_old',
          content: 'old AGENTS.md contents',
        },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: 'Read package.json and reply with exactly there' },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_new',
              function: {
                name: 'Read',
                arguments: '{"file_path":"package.json"}',
              },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_new',
          content: 'new package.json contents',
        },
      ],
    },
  ],
  message: { content: 'there' },
  response_meta: {
    usage: {
      prompt_tokens: 15,
      completion_tokens: 3,
      total_tokens: 18,
    },
  },
};

describe('TraeAgentService', () => {
  test('yields session_init, tool events, final text, and done from JSON payload', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new TraeAgentService({ catId: 'trae', spawnFn, model: 'GLM-5' });

    const promise = collect(service.invoke('Reply with exactly hi'));
    emitTraeJson(proc, SUCCESS_PAYLOAD);
    const messages = await promise;

    assert.equal(messages[0].type, 'session_init');
    assert.equal(messages[0].catId, 'trae');
    assert.ok(messages[0].sessionId);

    const toolUse = messages.find((msg) => msg.type === 'tool_use');
    assert.ok(toolUse);
    assert.equal(toolUse.toolName, 'Read');
    assert.deepEqual(toolUse.toolInput, { file_path: 'AGENTS.md' });

    const toolResult = messages.find((msg) => msg.type === 'tool_result');
    assert.ok(toolResult);
    assert.equal(toolResult.content, 'AGENTS.md contents');

    const text = messages.find((msg) => msg.type === 'text');
    assert.ok(text);
    assert.equal(text.content, 'hi');
    assert.equal(text.metadata?.provider, 'trae');
    assert.equal(text.metadata?.model, 'GLM-5');
    assert.deepEqual(text.metadata?.usage, {
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
    });

    const done = messages.at(-1);
    assert.equal(done?.type, 'done');
  });

  test('passes --json and --session-id for fresh sessions', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new TraeAgentService({ catId: 'trae', spawnFn, model: 'GLM-5' });

    const promise = collect(service.invoke('Test prompt'));
    emitTraeJson(proc, SUCCESS_PAYLOAD);
    const messages = await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    assert.ok(args.includes('-p'));
    assert.equal(args[0], '-p');
    assert.equal(args[1], 'Test prompt');
    assert.ok(args.includes('--json'));
    const queryTimeoutIdx = args.indexOf('--query-timeout');
    assert.ok(queryTimeoutIdx >= 0);
    assert.equal(args[queryTimeoutIdx + 1], '10m');
    const sessionIdx = args.indexOf('--session-id');
    assert.ok(sessionIdx >= 0);
    assert.ok(args[sessionIdx + 1]);
    assert.equal(messages[0].sessionId, args[sessionIdx + 1]);
  });

  test('passes --resume for resumed sessions', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new TraeAgentService({ catId: 'trae', spawnFn, model: 'GLM-5' });

    const promise = collect(service.invoke('Continue', { sessionId: 'existing-trae-session' }));
    emitTraeJson(proc, { ...SUCCESS_PAYLOAD, session_id: 'existing-trae-session' });
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    const resumeIdx = args.indexOf('--resume');
    assert.ok(resumeIdx >= 0);
    assert.equal(args[resumeIdx + 1], 'existing-trae-session');
    assert.ok(!args.includes('--session-id'));
  });

  test('replays only current-turn tool events when resume payload includes history', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new TraeAgentService({ catId: 'trae', spawnFn, model: 'GLM-5' });

    const promise = collect(service.invoke('Continue', { sessionId: 'trae-session-1' }));
    emitTraeJson(proc, RESUME_WITH_HISTORY_PAYLOAD);
    const messages = await promise;

    const toolUses = messages.filter((msg) => msg.type === 'tool_use');
    const toolResults = messages.filter((msg) => msg.type === 'tool_result');
    assert.equal(toolUses.length, 1);
    assert.equal(toolUses[0].toolName, 'Read');
    assert.deepEqual(toolUses[0].toolInput, { file_path: 'package.json' });
    assert.equal(toolResults.length, 1);
    assert.equal(toolResults[0].content, 'new package.json contents');
    const text = messages.find((msg) => msg.type === 'text');
    assert.equal(text?.content, 'there');
  });

  test('passes model override via -c model.name=...', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new TraeAgentService({ catId: 'trae', spawnFn, model: 'GLM-5' });

    const promise = collect(
      service.invoke('Test', {
        callbackEnv: { CAT_CAFE_TRAE_MODEL_OVERRIDE: 'GLM-5-Flash' },
      }),
    );
    emitTraeJson(proc, SUCCESS_PAYLOAD);
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    const configIdx = args.indexOf('-c');
    assert.ok(configIdx >= 0);
    assert.equal(args[configIdx + 1], 'model.name=GLM-5-Flash');
  });

  test('forwards user-defined cliConfigArgs and preserves explicit query-timeout overrides', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new TraeAgentService({ catId: 'trae', spawnFn, model: 'GLM-5' });

    const promise = collect(
      service.invoke('Test', {
        cliConfigArgs: ['--query-timeout 30s', '--dangerously-allow-all', '--label trae-test'],
      }),
    );
    emitTraeJson(proc, SUCCESS_PAYLOAD);
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    const queryTimeoutFlags = args.filter((arg) => arg === '--query-timeout');
    assert.equal(queryTimeoutFlags.length, 1);
    const queryTimeoutIdx = args.indexOf('--query-timeout');
    assert.equal(args[queryTimeoutIdx + 1], '30s');
    assert.ok(args.includes('--dangerously-allow-all'));
    assert.ok(args.includes('--label'));
    assert.ok(args.includes('trae-test'));
  });

  test('forwards invocation metadata to spawnCliOverride', async () => {
    const service = new TraeAgentService({ catId: 'trae', model: 'GLM-5' });
    const spawnCliOverride = mock.fn(async function* (opts) {
      assert.equal(opts.invocationId, 'inv-trae-1');
      assert.equal(opts.cliSessionId, 'cli-trae-1');
      yield SUCCESS_PAYLOAD;
    });

    const messages = await collect(
      service.invoke('Test', {
        invocationId: 'inv-trae-1',
        cliSessionId: 'cli-trae-1',
        spawnCliOverride,
      }),
    );

    assert.equal(spawnCliOverride.mock.callCount(), 1);
    assert.equal(messages.at(-1)?.type, 'done');
  });

  test('yields provider-specific error when stdout is not valid JSON', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new TraeAgentService({ catId: 'trae', spawnFn, model: 'GLM-5' });

    const promise = collect(service.invoke('Broken'));
    emitTraeStdout(proc, 'not-json');
    const messages = await promise;

    const error = messages.find((msg) => msg.type === 'error');
    assert.ok(error);
    assert.match(error.error, /Trae CLI returned invalid JSON/i);
  });

  test('parses pretty-printed JSON output from Trae CLI stdout', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new TraeAgentService({ catId: 'trae', spawnFn, model: 'GLM-5' });

    const promise = collect(service.invoke('Reply with exactly hi'));
    emitTraeStdout(proc, JSON.stringify(SUCCESS_PAYLOAD, null, 2));
    const messages = await promise;

    const errors = messages.filter((msg) => msg.type === 'error');
    assert.equal(errors.length, 0);
    const text = messages.find((msg) => msg.type === 'text');
    assert.ok(text);
    assert.equal(text.content, 'hi');
    assert.equal(messages.at(-1)?.type, 'done');
  });

  test('emits only one invalid JSON error for multiline non-JSON stdout', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new TraeAgentService({ catId: 'trae', spawnFn, model: 'GLM-5' });

    const promise = collect(service.invoke('Broken'));
    emitTraeStdout(proc, '{\nnot-json\nstill-bad\n}');
    const messages = await promise;

    const errors = messages.filter((msg) => msg.type === 'error');
    assert.equal(errors.length, 1);
    assert.match(errors[0].error, /Trae CLI returned invalid JSON/i);
  });

  test('yields error + done on CLI exit failure', async () => {
    const proc = createMockProcess(1);
    const spawnFn = mock.fn(() => proc);
    const service = new TraeAgentService({ catId: 'trae', spawnFn, model: 'GLM-5' });

    const promise = collect(service.invoke('Fail'));
    proc.stderr.write('panic: something bad happened');
    proc.stdout.end();
    process.nextTick(() => proc._emitter.emit('exit', 1, null));
    const messages = await promise;

    const error = messages.find((msg) => msg.type === 'error');
    assert.ok(error);
    assert.match(error.error, /Trae CLI/i);
    assert.equal(messages.at(-1)?.type, 'done');
  });
});
