// NIM (OpenAI-compatible) adapter for LlmPort: primary -> fallback chain, caps, retries,
// tool-call argument validation and secret redaction (LANE-P3 P3-1).

import OpenAI, { APIConnectionError, APIError, APIUserAbortError } from 'openai';
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolChoiceOption,
} from 'openai/resources/chat/completions';
import { requireConfig, redactString, type AgentConfig } from './config.js';
import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmMessage,
  LlmPort,
  LlmToolCall,
  LlmToolChoice,
  LlmToolDef,
  LlmUsage,
} from './ports.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Reasoning toggle sent as `chat_template_kwargs.enable_thinking`.
 * 'omit' sends nothing. If the server rejects the field (HTTP 400), the adapter retries once
 * without it and stops sending it to that endpoint for the lifetime of the client.
 */
export type ThinkingMode = 'disabled' | 'enabled' | 'omit';

export interface NimLlmOptions {
  /** Default 'disabled' (fastest for a multi-step tool loop, per NIM-SETUP.md). */
  thinking?: ThinkingMode;
  /** Retries per endpoint on 429 / 5xx / timeout / connection errors. Default 2. */
  maxRetries?: number;
  /** Base backoff in ms; attempt i waits base * 2^i (capped at 5 s). Default 400. */
  backoffMs?: number;
  /** Default 1.0 (NVIDIA guidance for Nemotron 3). */
  temperature?: number;
  /** Default 0.95. */
  topP?: number;
  /** Set false to skip the fallback endpoint even when configured. Default true. */
  useFallback?: boolean;
  /** Observability hook for retries, fallbacks and toggles. Never receives message content or keys. */
  onEvent?: (event: NimLlmEvent) => void;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export type NimEndpointLabel = 'primary' | 'fallback';

export type NimLlmEvent =
  | { type: 'retry'; endpoint: NimEndpointLabel; model: string; attempt: number; reason: string; delayMs: number }
  | { type: 'endpoint_failed'; endpoint: NimEndpointLabel; model: string; reason: string }
  | { type: 'thinking_flag_rejected'; endpoint: NimEndpointLabel; model: string }
  | { type: 'tool_args_invalid'; endpoint: NimEndpointLabel; model: string; corrective: boolean };

/** A tool call whose argumentsJson is not a JSON object (after the corrective retry). */
export interface LlmToolArgsError {
  toolCallId: string;
  name: string;
  error: string;
}

/**
 * LlmChatResponse plus `toolArgErrors` when the model kept returning malformed arguments.
 * In that case `finishReason` is 'invalid_tool_args'; callers should treat the turn as unusable.
 */
export interface NimChatResponse extends LlmChatResponse {
  toolArgErrors?: LlmToolArgsError[];
  /** Whether `chat_template_kwargs` was actually sent on the answering request. */
  thinkingFlagSent?: boolean;
}

export interface LlmAttemptFailure {
  endpoint: NimEndpointLabel;
  model: string;
  reason: string;
}

/** Both endpoints failed. Callers fall back to thresholdPolicy + needs_approval. */
export class LlmUnavailableError extends Error {
  readonly attempts: readonly LlmAttemptFailure[];
  constructor(message: string, attempts: readonly LlmAttemptFailure[]) {
    super(message);
    this.name = 'LlmUnavailableError';
    this.attempts = attempts;
  }
}

// ---------------------------------------------------------------------------
// Mapping ports <-> OpenAI chat format
// ---------------------------------------------------------------------------

export function toOpenAiMessages(messages: readonly LlmMessage[]): ChatCompletionMessageParam[] {
  return messages.map((m): ChatCompletionMessageParam => {
    switch (m.role) {
      case 'system':
      case 'user':
        return { role: m.role, content: m.content };
      case 'tool':
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
      case 'assistant': {
        const calls = m.toolCalls ?? [];
        if (calls.length === 0) return { role: 'assistant', content: m.content };
        return {
          role: 'assistant',
          content: m.content,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: 'function' as const,
            function: { name: c.name, arguments: c.argumentsJson },
          })),
        };
      }
    }
  });
}

export function toOpenAiTools(tools: readonly LlmToolDef[]): ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export function toOpenAiToolChoice(choice: LlmToolChoice): ChatCompletionToolChoiceOption {
  return typeof choice === 'string' ? choice : { type: 'function', function: { name: choice.name } };
}

export function fromOpenAiCompletion(completion: ChatCompletion, fallbackModel: string): LlmChatResponse {
  const choice = completion.choices?.[0];
  const message = choice?.message;
  const toolCalls: LlmToolCall[] = [];
  (message?.tool_calls ?? []).forEach((tc, i) => {
    if (tc.type !== undefined && tc.type !== 'function') return;
    const fn = (tc as { function?: { name?: unknown; arguments?: unknown } }).function;
    if (!fn || typeof fn.name !== 'string') return;
    const args = fn.arguments;
    toolCalls.push({
      id: typeof tc.id === 'string' && tc.id !== '' ? tc.id : `call-${i}`,
      name: fn.name,
      // Some servers return an object instead of a JSON string; normalise to a string.
      argumentsJson: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
    });
  });
  const u = completion.usage;
  const usage: LlmUsage | undefined = u
    ? { promptTokens: u.prompt_tokens ?? 0, completionTokens: u.completion_tokens ?? 0, totalTokens: u.total_tokens ?? 0 }
    : undefined;
  const out: LlmChatResponse = {
    content: typeof message?.content === 'string' ? message.content : null,
    toolCalls,
    model: completion.model || fallbackModel,
  };
  if (choice?.finish_reason) out.finishReason = choice.finish_reason;
  if (usage) out.usage = usage;
  return out;
}

/** Returns an error per tool call whose argumentsJson is not a JSON object. */
export function validateToolArgs(calls: readonly LlmToolCall[]): LlmToolArgsError[] {
  const errors: LlmToolArgsError[] = [];
  for (const c of calls) {
    try {
      const v: unknown = JSON.parse(c.argumentsJson === '' ? '{}' : c.argumentsJson);
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        errors.push({ toolCallId: c.id, name: c.name, error: 'arguments must be a JSON object' });
      }
    } catch (e) {
      errors.push({ toolCallId: c.id, name: c.name, error: `invalid JSON: ${(e as Error).message}` });
    }
  }
  return errors;
}

/** Effective max_tokens: request may lower the configured cap, never raise it. */
export function capMaxTokens(cfgMax: number, requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return cfgMax;
  return Math.max(1, Math.min(cfgMax, Math.floor(requested)));
}

const CORRECTIVE_NUDGE =
  'Your previous tool call had arguments that were not a valid JSON object. ' +
  'Call the tool again with arguments as a single valid JSON object matching its schema. No prose.';

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/** LlmPort whose chat() returns the richer NimChatResponse. */
export interface NimLlm extends LlmPort {
  chat(req: LlmChatRequest): Promise<NimChatResponse>;
  readonly endpoints: readonly { label: NimEndpointLabel; baseURL: string; model: string }[];
}

interface Endpoint {
  label: NimEndpointLabel;
  baseURL: string;
  model: string;
  client: OpenAI;
  thinkingFlagSupported: boolean;
}

type AttemptResult =
  | { ok: true; response: LlmChatResponse; thinkingFlagSent: boolean }
  | { ok: false; retryable: boolean; reason: string; status?: number };

const MAX_BACKOFF_MS = 5_000;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isRetryableStatus(status: number | undefined): boolean {
  return status === 429 || status === 408 || (status !== undefined && status >= 500);
}

/**
 * Build an LlmPort backed by NIM. Requires NIM_API_KEY and NIM_MODEL.
 * Primary: NIM_BASE_URL (or the hosted default when unset) + NIM_MODEL.
 * Fallback: NIM_FALLBACK_BASE_URL + NIM_FALLBACK_MODEL (same key), when NIM_FALLBACK_MODEL is set.
 */
export function createNimLlm(cfg: AgentConfig, opts: NimLlmOptions = {}): NimLlm {
  const c = requireConfig(cfg, ['NIM_API_KEY', 'NIM_MODEL']);
  const thinking: ThinkingMode = opts.thinking ?? 'disabled';
  const maxRetries = Math.max(0, opts.maxRetries ?? 2);
  const backoffMs = Math.max(0, opts.backoffMs ?? 400);
  const temperature = opts.temperature ?? 1.0;
  const topP = opts.topP ?? 0.95;
  const sleep = opts.sleep ?? defaultSleep;
  const emit = (e: NimLlmEvent) => {
    try {
      opts.onEvent?.(e);
    } catch {
      /* observers must not break the call */
    }
  };
  const redact = (s: string) => redactString(s, cfg);

  const makeEndpoint = (label: NimEndpointLabel, baseURL: string, model: string): Endpoint => ({
    label,
    baseURL,
    model,
    // SDK retries off: retries/backoff/timeouts are handled here so fallback timing is predictable.
    client: new OpenAI({ baseURL, apiKey: c.NIM_API_KEY, maxRetries: 0, timeout: cfg.LLM_TIMEOUT_MS + 1_000 }),
    thinkingFlagSupported: thinking !== 'omit',
  });

  const endpoints: Endpoint[] = [makeEndpoint('primary', cfg.NIM_BASE_URL ?? cfg.NIM_FALLBACK_BASE_URL, c.NIM_MODEL)];
  if (opts.useFallback !== false && cfg.NIM_FALLBACK_MODEL) {
    const same = cfg.NIM_FALLBACK_BASE_URL === endpoints[0]!.baseURL && cfg.NIM_FALLBACK_MODEL === c.NIM_MODEL;
    if (!same) endpoints.push(makeEndpoint('fallback', cfg.NIM_FALLBACK_BASE_URL, cfg.NIM_FALLBACK_MODEL));
  }

  async function attemptOnce(ep: Endpoint, req: LlmChatRequest, extraSystem?: string): Promise<AttemptResult> {
    const messages = toOpenAiMessages(req.messages);
    if (extraSystem) messages.push({ role: 'system', content: extraSystem });
    const body: ChatCompletionCreateParamsNonStreaming & { chat_template_kwargs?: { enable_thinking: boolean } } = {
      model: ep.model,
      messages,
      max_tokens: capMaxTokens(cfg.LLM_MAX_TOKENS, req.maxTokens),
      temperature,
      top_p: topP,
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = toOpenAiTools(req.tools);
      if (req.toolChoice !== undefined) body.tool_choice = toOpenAiToolChoice(req.toolChoice);
    }
    const sendFlag = ep.thinkingFlagSupported && thinking !== 'omit';
    if (sendFlag) body.chat_template_kwargs = { enable_thinking: thinking === 'enabled' };

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, cfg.LLM_TIMEOUT_MS);
    try {
      const completion = await ep.client.chat.completions.create(body, { signal: controller.signal });
      return { ok: true, response: fromOpenAiCompletion(completion, ep.model), thinkingFlagSent: sendFlag };
    } catch (err) {
      if (timedOut || err instanceof APIUserAbortError) {
        return { ok: false, retryable: true, reason: `timeout after ${cfg.LLM_TIMEOUT_MS} ms` };
      }
      if (err instanceof APIError && err.status !== undefined) {
        if (err.status === 400 && sendFlag) {
          // Most likely the server does not accept chat_template_kwargs: drop it for this endpoint.
          ep.thinkingFlagSupported = false;
          emit({ type: 'thinking_flag_rejected', endpoint: ep.label, model: ep.model });
          return await attemptOnce(ep, req, extraSystem);
        }
        return {
          ok: false,
          retryable: isRetryableStatus(err.status),
          status: err.status,
          reason: redact(`HTTP ${err.status}: ${err.message}`).slice(0, 300),
        };
      }
      if (err instanceof APIConnectionError) {
        return { ok: false, retryable: true, reason: redact(`connection error: ${err.message}`).slice(0, 300) };
      }
      return { ok: false, retryable: false, reason: redact(`unexpected error: ${(err as Error)?.message ?? String(err)}`).slice(0, 300) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Up to 1 + maxRetries attempts on one endpoint. */
  async function callEndpoint(ep: Endpoint, req: LlmChatRequest, extraSystem?: string): Promise<AttemptResult> {
    let last: AttemptResult = { ok: false, retryable: false, reason: 'not attempted' };
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      last = await attemptOnce(ep, req, extraSystem);
      if (last.ok || !last.retryable || attempt === maxRetries) return last;
      const delayMs = Math.min(MAX_BACKOFF_MS, backoffMs * 2 ** attempt);
      emit({ type: 'retry', endpoint: ep.label, model: ep.model, attempt: attempt + 1, reason: last.reason, delayMs });
      await sleep(delayMs);
    }
    return last;
  }

  async function chat(req: LlmChatRequest): Promise<NimChatResponse> {
    const failures: LlmAttemptFailure[] = [];
    for (const ep of endpoints) {
      const first = await callEndpoint(ep, req);
      if (!first.ok) {
        failures.push({ endpoint: ep.label, model: ep.model, reason: first.reason });
        emit({ type: 'endpoint_failed', endpoint: ep.label, model: ep.model, reason: first.reason });
        continue;
      }
      if (validateToolArgs(first.response.toolCalls).length === 0) {
        return { ...first.response, thinkingFlagSent: first.thinkingFlagSent };
      }
      // Malformed tool args: one corrective retry with a short system nudge.
      emit({ type: 'tool_args_invalid', endpoint: ep.label, model: ep.model, corrective: true });
      const second = await callEndpoint(ep, req, CORRECTIVE_NUDGE);
      const answer = second.ok ? second : first;
      const errors = validateToolArgs(answer.response.toolCalls);
      if (errors.length === 0) return { ...answer.response, thinkingFlagSent: answer.thinkingFlagSent };
      emit({ type: 'tool_args_invalid', endpoint: ep.label, model: ep.model, corrective: false });
      return {
        ...answer.response,
        finishReason: 'invalid_tool_args',
        toolArgErrors: errors,
        thinkingFlagSent: answer.thinkingFlagSent,
      };
    }
    const summary = failures.map((f) => `${f.endpoint} ${f.model}: ${f.reason}`).join('; ');
    throw new LlmUnavailableError(redact(`LLM unavailable (${summary || 'no endpoints'})`), failures);
  }

  return {
    chat,
    endpoints: endpoints.map(({ label, baseURL, model }) => ({ label, baseURL, model })),
  };
}

// ---------------------------------------------------------------------------
// Logging wrapper (F-NV1 feed): latency/model/finish_reason per call, never content.
// ---------------------------------------------------------------------------

export interface LlmCallLog {
  ok: boolean;
  latencyMs: number;
  model: string | null;
  finishReason: string | null;
  toolCallCount: number;
  toolNames: string[];
  usage?: LlmUsage;
  /** Error class name only (e.g. LlmUnavailableError); messages are not logged. */
  errorName?: string;
}

export function createLoggingLlm(inner: LlmPort, log: (entry: LlmCallLog) => void): LlmPort {
  const safeLog = (e: LlmCallLog) => {
    try {
      log(e);
    } catch {
      /* logging must not break the call */
    }
  };
  return {
    async chat(req: LlmChatRequest): Promise<LlmChatResponse> {
      const t0 = performance.now();
      try {
        const res = await inner.chat(req);
        const entry: LlmCallLog = {
          ok: true,
          latencyMs: Math.round(performance.now() - t0),
          model: res.model,
          finishReason: res.finishReason ?? null,
          toolCallCount: res.toolCalls.length,
          toolNames: res.toolCalls.map((t) => t.name),
        };
        if (res.usage) entry.usage = res.usage;
        safeLog(entry);
        return res;
      } catch (err) {
        safeLog({
          ok: false,
          latencyMs: Math.round(performance.now() - t0),
          model: null,
          finishReason: null,
          toolCallCount: 0,
          toolNames: [],
          errorName: (err as Error)?.name ?? 'Error',
        });
        throw err;
      }
    },
  };
}
