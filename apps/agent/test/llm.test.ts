import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type AgentConfig } from '../src/config.js';
import {
  LlmUnavailableError,
  capMaxTokens,
  createLoggingLlm,
  createNimLlm,
  type LlmCallLog,
  type NimLlmEvent,
} from '../src/llm.js';
import type { LlmChatRequest } from '../src/ports.js';

// ---------------------------------------------------------------------------
// Fake OpenAI-compatible server on an ephemeral port. Routes: /primary/v1/*, /fallback/v1/*.
// Each route has a queue of handlers; when empty, the route returns 500.
// ---------------------------------------------------------------------------

const KEY = 'nvapi-TEST-SECRET-KEY-1234567890';

type Recorded = { route: string; body: Record<string, unknown>; auth: string | undefined };
type Handler = (body: Record<string, unknown>, res: ServerResponse) => void;

const queues: Record<string, Handler[]> = { primary: [], fallback: [] };
const recorded: Recorded[] = [];
let server: Server;
let base = '';

function json(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function completion(model: string, message: Record<string, unknown>, finish = 'stop') {
  return {
    id: 'cmpl-1',
    object: 'chat.completion',
    created: 0,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: null, ...message }, finish_reason: finish }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  };
}

const toolCallReply =
  (model: string, args: string, name = 'get_job_state'): Handler =>
  (_b, res) =>
    json(
      res,
      200,
      completion(model, { tool_calls: [{ id: 'call-abc', type: 'function', function: { name, arguments: args } }] }, 'tool_calls'),
    );
const textReply =
  (model: string, content: string): Handler =>
  (_b, res) =>
    json(res, 200, completion(model, { content }));
const statusReply =
  (status: number, message = 'boom'): Handler =>
  (_b, res) =>
    json(res, status, { error: { message, type: 'error' } });
const hang: Handler = () => {
  /* never respond; the client must time out */
};

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const route = (req.url ?? '').split('/')[1] ?? '';
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      recorded.push({ route, body, auth: req.headers.authorization });
      const h = queues[route]?.shift();
      if (!h) return json(res, 500, { error: { message: 'no handler queued' } });
      h(body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  queues.primary = [];
  queues.fallback = [];
  recorded.length = 0;
});

function cfg(overrides: Record<string, string> = {}): AgentConfig {
  return loadConfig(
    {
      NIM_BASE_URL: `${base}/primary/v1`,
      NIM_API_KEY: KEY,
      NIM_MODEL: 'nvidia/primary-model',
      NIM_FALLBACK_BASE_URL: `${base}/fallback/v1`,
      NIM_FALLBACK_MODEL: 'nvidia/fallback-model',
      LLM_MAX_TOKENS: '512',
      LLM_TIMEOUT_MS: '2000',
      LLM_RETRIES: '2',
      ...overrides,
    },
    {},
  );
}

const noSleep = async () => {};

const REQ: LlmChatRequest = {
  messages: [
    { role: 'system', content: 'You are a GPU-cluster incident engineer.' },
    { role: 'user', content: 'What is the state of job-a?' },
    { role: 'assistant', content: null, toolCalls: [{ id: 'call-1', name: 'get_job_state', argumentsJson: '{"job_ids":["job-a"]}' }] },
    { role: 'tool', toolCallId: 'call-1', content: '{"job-a":"running"}' },
  ],
  tools: [
    {
      name: 'get_job_state',
      description: 'Get job state',
      parameters: { type: 'object', properties: { job_ids: { type: 'array', items: { type: 'string' } } }, required: ['job_ids'] },
    },
  ],
  toolChoice: 'auto',
};

describe('createNimLlm', () => {
  it('maps request and tool-call response exactly (happy path)', async () => {
    queues.primary!.push(toolCallReply('nvidia/primary-model', '{"job_ids":["job-a"]}'));
    const llm = createNimLlm(cfg(), { sleep: noSleep });
    const res = await llm.chat(REQ);

    expect(res.model).toBe('nvidia/primary-model');
    expect(res.finishReason).toBe('tool_calls');
    expect(res.toolCalls).toEqual([{ id: 'call-abc', name: 'get_job_state', argumentsJson: '{"job_ids":["job-a"]}' }]);
    expect(res.usage).toEqual({ promptTokens: 11, completionTokens: 7, totalTokens: 18 });

    expect(recorded).toHaveLength(1);
    const { body, auth } = recorded[0]!;
    expect(auth).toBe(`Bearer ${KEY}`);
    expect(body.model).toBe('nvidia/primary-model');
    expect(body.temperature).toBe(1);
    expect(body.top_p).toBe(0.95);
    expect(body.max_tokens).toBe(512);
    expect(body.tool_choice).toBe('auto');
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.tools).toEqual([{ type: 'function', function: REQ.tools![0] }]);
    expect(body.messages).toEqual([
      { role: 'system', content: 'You are a GPU-cluster incident engineer.' },
      { role: 'user', content: 'What is the state of job-a?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'get_job_state', arguments: '{"job_ids":["job-a"]}' } }],
      },
      { role: 'tool', tool_call_id: 'call-1', content: '{"job-a":"running"}' },
    ]);
  });

  it('takes thinking mode and retries from config when opts do not override', async () => {
    queues.primary!.push(textReply('nvidia/primary-model', 'a'), textReply('nvidia/primary-model', 'b'));
    await createNimLlm(cfg({ NIM_ENABLE_THINKING: 'true' }), { sleep: noSleep }).chat(REQ);
    await createNimLlm(cfg({ NIM_ENABLE_THINKING: 'omit' }), { sleep: noSleep }).chat(REQ);
    expect(recorded[0]!.body.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(recorded[1]!.body.chat_template_kwargs).toBeUndefined();
    recorded.length = 0;
    const llm = createNimLlm(cfg({ LLM_RETRIES: '0', NIM_FALLBACK_MODEL: '' }), { sleep: noSleep });
    await llm.chat(REQ).catch(() => undefined);
    expect(recorded).toHaveLength(1);
  });

  it('maps a named tool choice and plain text replies', async () => {
    queues.primary!.push(textReply('nvidia/primary-model', 'needs_approval'));
    const llm = createNimLlm(cfg(), { sleep: noSleep });
    const res = await llm.chat({ ...REQ, toolChoice: { name: 'get_job_state' } });
    expect(res.content).toBe('needs_approval');
    expect(res.toolCalls).toEqual([]);
    expect(recorded[0]!.body.tool_choice).toEqual({ type: 'function', function: { name: 'get_job_state' } });
  });

  it('retries after 429 then succeeds on the primary', async () => {
    queues.primary!.push(statusReply(429, 'rate limited'), toolCallReply('nvidia/primary-model', '{"job_ids":["job-a"]}'));
    const events: NimLlmEvent[] = [];
    const llm = createNimLlm(cfg(), { sleep: noSleep, onEvent: (e) => events.push(e) });
    const res = await llm.chat(REQ);
    expect(res.model).toBe('nvidia/primary-model');
    expect(recorded.map((r) => r.route)).toEqual(['primary', 'primary']);
    expect(events.filter((e) => e.type === 'retry')).toHaveLength(1);
  });

  it('falls back to the secondary model when the primary times out', async () => {
    queues.primary!.push(hang, hang, hang);
    queues.fallback!.push(toolCallReply('nvidia/fallback-model', '{"job_ids":["job-a"]}'));
    const llm = createNimLlm(cfg({ LLM_TIMEOUT_MS: '150' }), { sleep: noSleep });
    const res = await llm.chat(REQ);
    expect(res.model).toBe('nvidia/fallback-model');
    expect(recorded.map((r) => r.route)).toEqual(['primary', 'primary', 'primary', 'fallback']);
    expect(recorded[3]!.body.model).toBe('nvidia/fallback-model');
  });

  it('throws LlmUnavailableError when both endpoints are down', async () => {
    const llm = createNimLlm(cfg(), { sleep: noSleep });
    const err = await llm.chat(REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmUnavailableError);
    const e = err as LlmUnavailableError;
    expect(e.attempts.map((a) => a.endpoint)).toEqual(['primary', 'fallback']);
    expect(recorded).toHaveLength(6); // 3 attempts per endpoint
  });

  it('does not retry non-retryable errors on the same endpoint', async () => {
    queues.primary!.push(statusReply(401, 'unauthorized'));
    queues.fallback!.push(toolCallReply('nvidia/fallback-model', '{"job_ids":[]}'));
    const llm = createNimLlm(cfg({ NIM_FALLBACK_BASE_URL: `${base}/fallback/v1` }), { sleep: noSleep, thinking: 'omit' });
    const res = await llm.chat(REQ);
    expect(res.model).toBe('nvidia/fallback-model');
    expect(recorded.map((r) => r.route)).toEqual(['primary', 'fallback']);
  });

  it('runs one corrective retry on malformed tool args', async () => {
    queues.primary!.push(
      toolCallReply('nvidia/primary-model', '{"job_ids": ["job-a"'),
      toolCallReply('nvidia/primary-model', '{"job_ids":["job-a"]}'),
    );
    const llm = createNimLlm(cfg(), { sleep: noSleep });
    const res = await llm.chat(REQ);
    expect(res.toolCalls[0]!.argumentsJson).toBe('{"job_ids":["job-a"]}');
    expect(res.toolArgErrors).toBeUndefined();
    const msgs = recorded[1]!.body.messages as { role: string; content: string }[];
    expect(msgs.at(-1)!.role).toBe('system');
    expect(msgs.at(-1)!.content).toMatch(/valid JSON object/);
  });

  it('surfaces persistently malformed tool args as a parse-error result instead of throwing', async () => {
    queues.primary!.push(toolCallReply('nvidia/primary-model', 'not json'), toolCallReply('nvidia/primary-model', '[1,2]'));
    const llm = createNimLlm(cfg(), { sleep: noSleep });
    const res = await llm.chat(REQ);
    expect(res.finishReason).toBe('invalid_tool_args');
    expect(res.toolArgErrors).toHaveLength(1);
    expect(res.toolArgErrors![0]!.name).toBe('get_job_state');
    expect(recorded).toHaveLength(2);
  });

  it('never includes the API key in error messages', async () => {
    const leak: Handler = (_b, res) => json(res, 503, { error: { message: `upstream rejected key ${KEY}` } });
    queues.primary!.push(leak, leak, leak);
    queues.fallback!.push(leak, leak, leak);
    const llm = createNimLlm(cfg(), { sleep: noSleep });
    const err = (await llm.chat(REQ).catch((e: unknown) => e)) as LlmUnavailableError;
    expect(err).toBeInstanceOf(LlmUnavailableError);
    expect(err.message).toContain('***');
    expect(err.message).not.toContain(KEY);
    expect(JSON.stringify(err.attempts)).not.toContain(KEY);
    expect(String(err.stack)).not.toContain(KEY);
  });

  it('caps max_tokens: the request may lower but never raise the configured cap', async () => {
    queues.primary!.push(textReply('nvidia/primary-model', 'a'), textReply('nvidia/primary-model', 'b'));
    const llm = createNimLlm(cfg(), { sleep: noSleep });
    await llm.chat({ ...REQ, maxTokens: 4096 });
    await llm.chat({ ...REQ, maxTokens: 64 });
    expect(recorded.map((r) => r.body.max_tokens)).toEqual([512, 64]);
    expect(capMaxTokens(512, undefined)).toBe(512);
    expect(capMaxTokens(512, 0)).toBe(1);
  });

  it('drops chat_template_kwargs when the server rejects it with 400', async () => {
    queues.primary!.push(statusReply(400, 'unknown field chat_template_kwargs'), textReply('nvidia/primary-model', 'ok'), textReply('nvidia/primary-model', 'ok2'));
    const events: NimLlmEvent[] = [];
    const llm = createNimLlm(cfg(), { sleep: noSleep, onEvent: (e) => events.push(e) });
    const res = await llm.chat(REQ);
    expect(res.content).toBe('ok');
    expect(res.thinkingFlagSent).toBe(false);
    await llm.chat(REQ);
    expect(recorded.map((r) => 'chat_template_kwargs' in r.body)).toEqual([true, false, false]);
    expect(events.some((e) => e.type === 'thinking_flag_rejected')).toBe(true);
  });

  it('requires NIM_API_KEY and NIM_MODEL', () => {
    expect(() => createNimLlm(cfg({ NIM_API_KEY: '' }))).toThrow(/NIM_API_KEY/);
  });
});

describe('createLoggingLlm', () => {
  it('records latency, model and finish_reason without content', async () => {
    queues.primary!.push(toolCallReply('nvidia/primary-model', '{"job_ids":["job-a"]}'));
    const logs: LlmCallLog[] = [];
    const llm = createLoggingLlm(createNimLlm(cfg(), { sleep: noSleep }), (e) => logs.push(e));
    await llm.chat(REQ);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ ok: true, model: 'nvidia/primary-model', finishReason: 'tool_calls', toolCallCount: 1, toolNames: ['get_job_state'] });
    expect(logs[0]!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(logs)).not.toContain('job-a');
  });

  it('logs failures by error name only and rethrows', async () => {
    const logs: LlmCallLog[] = [];
    const llm = createLoggingLlm(createNimLlm(cfg(), { sleep: noSleep }), (e) => logs.push(e));
    await expect(llm.chat(REQ)).rejects.toBeInstanceOf(LlmUnavailableError);
    expect(logs[0]).toMatchObject({ ok: false, errorName: 'LlmUnavailableError', model: null });
  });
});
