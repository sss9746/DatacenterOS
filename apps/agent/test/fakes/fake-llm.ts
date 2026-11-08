// ===========================================================================
//  TEST-ONLY. Scripted LlmPort: returns queued responses in order and records
//  every request. Never import this from apps/agent/src/**.
// ===========================================================================

import type { LlmChatRequest, LlmChatResponse, LlmPort } from '../../src/ports.js';

export type FakeLlmStep = LlmChatResponse | Error | ((req: LlmChatRequest) => LlmChatResponse | Promise<LlmChatResponse>);

export const FAKE_LLM_MODEL = 'fake-nemotron';

export class FakeLlm implements LlmPort {
  readonly requests: LlmChatRequest[] = [];
  private readonly queue: FakeLlmStep[];

  constructor(script: FakeLlmStep[] = []) {
    this.queue = [...script];
  }

  /** Append more scripted steps. */
  push(...steps: FakeLlmStep[]): this {
    this.queue.push(...steps);
    return this;
  }

  get remaining(): number {
    return this.queue.length;
  }

  async chat(req: LlmChatRequest): Promise<LlmChatResponse> {
    this.requests.push(structuredClone(req));
    const step = this.queue.shift();
    if (step === undefined) throw new Error(`FakeLlm: script exhausted after ${this.requests.length - 1} call(s)`);
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? step(req) : structuredClone(step);
  }

  /** A response with one tool call. `args` may be an object or a raw (possibly invalid) JSON string. */
  static toolCall(name: string, args: Record<string, unknown> | string, id?: string): LlmChatResponse {
    return FakeLlm.toolCalls([{ name, args, id }]);
  }

  static toolCalls(calls: { name: string; args: Record<string, unknown> | string; id?: string }[]): LlmChatResponse {
    return {
      content: null,
      toolCalls: calls.map((c, i) => ({
        id: c.id ?? `call-${i}`,
        name: c.name,
        argumentsJson: typeof c.args === 'string' ? c.args : JSON.stringify(c.args),
      })),
      model: FAKE_LLM_MODEL,
      finishReason: 'tool_calls',
    };
  }

  /** A plain text response with no tool calls. */
  static text(content: string): LlmChatResponse {
    return { content, toolCalls: [], model: FAKE_LLM_MODEL, finishReason: 'stop' };
  }
}
