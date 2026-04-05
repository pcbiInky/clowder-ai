import { randomUUID } from 'node:crypto';
import { type CatId, createCatId } from '@cat-cafe/shared';
import { getCatModel } from '../../../../../config/cat-models.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { formatCliExitError } from '../../../../../utils/cli-format.js';
import { formatCliNotFoundError, resolveCliCommand } from '../../../../../utils/cli-resolve.js';
import { isParseError } from '../../../../../utils/ndjson-parser.js';
import { isCliError, isCliTimeout, isLivenessWarning, spawnCli } from '../../../../../utils/cli-spawn.js';
import type { SpawnFn } from '../../../../../utils/cli-types.js';
import type { AgentMessage, AgentService, AgentServiceOptions, MessageMetadata, TokenUsage } from '../../types.js';

const log = createModuleLogger('trae-agent');

interface TraeAgentServiceOptions {
  catId?: CatId;
  model?: string;
  spawnFn?: SpawnFn;
}

interface TraeToolCall {
  id?: string;
  function?: {
    name?: string;
    arguments?: unknown;
  };
}

interface TraeMessage {
  role?: string;
  content?: unknown;
  tool_calls?: TraeToolCall[];
  tool_call_id?: string;
}

interface TraePayload {
  session_id?: string;
  message?: { content?: unknown };
  response_meta?: { usage?: Record<string, unknown> };
  agent_states?: Array<{ messages?: TraeMessage[] }>;
}

const DEFAULT_TRAE_QUERY_TIMEOUT = '10m';

function parseToolInput(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return { raw };
    }
    return { raw };
  }
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

function normalizeTextContent(content: unknown): string | null {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (Array.isArray(content)) {
    const joined = content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (typeof item === 'object' && item !== null && 'text' in item) {
          return typeof item.text === 'string' ? item.text : '';
        }
        return '';
      })
      .join('')
      .trim();
    return joined.length > 0 ? joined : null;
  }
  if (typeof content === 'object' && content !== null && 'text' in content) {
    const text = typeof content.text === 'string' ? content.text.trim() : '';
    return text.length > 0 ? text : null;
  }
  return null;
}

function normalizeToolResultContent(content: unknown): string {
  const text = normalizeTextContent(content);
  if (text !== null) return text;
  return JSON.stringify(content);
}

function toUsage(payload: TraePayload): TokenUsage | undefined {
  const usage = payload.response_meta?.usage;
  if (!usage) return undefined;
  const inputTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined;
  const outputTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined;
  const totalTokens = typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined;
  if (inputTokens == null && outputTokens == null && totalTokens == null) return undefined;
  return {
    ...(inputTokens != null ? { inputTokens } : {}),
    ...(outputTokens != null ? { outputTokens } : {}),
    ...(totalTokens != null ? { totalTokens } : {}),
  };
}

function isTraePayload(value: unknown): value is TraePayload {
  return typeof value === 'object' && value !== null;
}

function hasQueryTimeoutArg(cliConfigArgs?: readonly string[]): boolean {
  return (cliConfigArgs ?? []).some((arg) => /(?:^|\s)--query-timeout(?:=|\s|$)/.test(arg.trim()));
}

function currentTurnMessages(messages: TraeMessage[]): TraeMessage[] {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      lastUserIndex = index;
      break;
    }
  }
  return lastUserIndex >= 0 ? messages.slice(lastUserIndex + 1) : messages;
}

export class TraeAgentService implements AgentService {
  readonly catId: CatId;
  private readonly model: string;
  private readonly spawnFn: SpawnFn | undefined;

  constructor(options?: TraeAgentServiceOptions) {
    this.catId = options?.catId ?? createCatId('trae');
    this.model = options?.model ?? getCatModel(this.catId as string);
    this.spawnFn = options?.spawnFn;
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const effectiveModel =
      options?.callbackEnv?.CAT_CAFE_TRAE_MODEL_OVERRIDE ?? options?.callbackEnv?.CAT_CAFE_OPENAI_MODEL_OVERRIDE ?? this.model;
    const sessionId = options?.sessionId ?? randomUUID();
    const args = this.buildArgs(prompt, effectiveModel, sessionId, Boolean(options?.sessionId), options?.cliConfigArgs);
    const metadata: MessageMetadata = {
      provider: 'trae',
      model: effectiveModel,
      sessionId,
    };

    const traeCommand = resolveCliCommand('trae-cli');
    if (!traeCommand) {
      yield {
        type: 'error',
        catId: this.catId,
        error: formatCliNotFoundError('trae-cli'),
        metadata,
        timestamp: Date.now(),
      };
      yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
      return;
    }

    yield {
      type: 'session_init',
      catId: this.catId,
      sessionId,
      metadata,
      timestamp: Date.now(),
    };

    try {
      const cliOpts = {
        command: traeCommand,
        args,
        ...(options?.workingDirectory ? { cwd: options.workingDirectory } : {}),
        ...(options?.callbackEnv ? { env: options.callbackEnv } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
        ...(options?.cliSessionId ? { cliSessionId: options.cliSessionId } : {}),
        ...(options?.livenessProbe ? { livenessProbe: options.livenessProbe } : {}),
      };
      const events = options?.spawnCliOverride
        ? options.spawnCliOverride(cliOpts)
        : spawnCli(cliOpts, this.spawnFn ? { spawnFn: this.spawnFn } : undefined);

      let sawPayload = false;
      for await (const event of events) {
        if (isCliTimeout(event)) {
          yield {
            type: 'system_info',
            catId: this.catId,
            content: JSON.stringify({
              type: 'timeout_diagnostics',
              silenceDurationMs: event.silenceDurationMs,
              processAlive: event.processAlive,
              lastEventType: event.lastEventType,
              firstEventAt: event.firstEventAt,
              lastEventAt: event.lastEventAt,
              cliSessionId: event.cliSessionId,
              invocationId: event.invocationId,
              rawArchivePath: event.rawArchivePath,
            }),
            timestamp: Date.now(),
          };
          yield {
            type: 'error',
            catId: this.catId,
            error: `Trae CLI 响应超时 (${Math.round(event.timeoutMs / 1000)}s${event.firstEventAt == null ? ', 未收到首帧' : ''})`,
            metadata,
            timestamp: Date.now(),
          };
          continue;
        }
        if (isLivenessWarning(event)) {
          log.warn(
            {
              catId: this.catId,
              invocationId: options?.invocationId,
              level: event.level,
              silenceMs: event.silenceDurationMs,
            },
            '[TraeAgent] liveness warning — CLI may be stuck',
          );
          yield {
            type: 'system_info',
            catId: this.catId,
            content: JSON.stringify({ type: 'liveness_warning', ...event }),
            timestamp: Date.now(),
          };
          continue;
        }
        if (isCliError(event)) {
          yield {
            type: 'error',
            catId: this.catId,
            error: formatCliExitError('Trae CLI', event),
            metadata,
            timestamp: Date.now(),
          };
          continue;
        }
        if (isParseError(event)) {
          yield {
            type: 'error',
            catId: this.catId,
            error: 'Trae CLI returned invalid JSON',
            metadata,
            timestamp: Date.now(),
          };
          continue;
        }
        if (!isTraePayload(event)) {
          yield {
            type: 'error',
            catId: this.catId,
            error: 'Trae CLI returned invalid JSON',
            metadata,
            timestamp: Date.now(),
          };
          continue;
        }

        sawPayload = true;
        const payload = event as TraePayload;
        const usage = toUsage(payload);
        if (usage) metadata.usage = usage;

        for (const state of payload.agent_states ?? []) {
          for (const message of currentTurnMessages(state.messages ?? [])) {
            if (message.role === 'assistant') {
              for (const toolCall of message.tool_calls ?? []) {
                const toolName = toolCall.function?.name?.trim();
                if (!toolName) continue;
                yield {
                  type: 'tool_use',
                  catId: this.catId,
                  toolName,
                  toolInput: parseToolInput(toolCall.function?.arguments),
                  metadata,
                  timestamp: Date.now(),
                };
              }
              continue;
            }
            if (message.role === 'tool') {
              yield {
                type: 'tool_result',
                catId: this.catId,
                content: normalizeToolResultContent(message.content),
                metadata,
                timestamp: Date.now(),
              };
            }
          }
        }

        const finalText = normalizeTextContent(payload.message?.content);
        if (finalText) {
          yield {
            type: 'text',
            catId: this.catId,
            content: finalText,
            metadata,
            timestamp: Date.now(),
          };
        }
      }

      if (!sawPayload) {
        yield {
          type: 'error',
          catId: this.catId,
          error: 'Trae CLI returned invalid JSON',
          metadata,
          timestamp: Date.now(),
        };
      }
      yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
    } catch (err) {
      yield {
        type: 'error',
        catId: this.catId,
        error: err instanceof Error ? err.message : String(err),
        metadata,
        timestamp: Date.now(),
      };
      yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
    }
  }

  private buildArgs(
    prompt: string,
    model: string,
    sessionId: string,
    isResume: boolean,
    cliConfigArgs?: readonly string[],
  ): string[] {
    const args = ['-p', prompt, '--json'];
    if (isResume) {
      args.push('--resume', sessionId);
    } else {
      args.push('--session-id', sessionId);
    }
    args.push('-c', `model.name=${model}`);
    if (!hasQueryTimeoutArg(cliConfigArgs)) {
      args.push('--query-timeout', DEFAULT_TRAE_QUERY_TIMEOUT);
    }
    for (const arg of cliConfigArgs ?? []) {
      args.push(...arg.trim().split(/\s+/));
    }
    return args;
  }
}
