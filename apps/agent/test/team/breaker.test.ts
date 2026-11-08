import { describe, expect, it } from 'vitest';
import { withLlmCircuitBreaker } from '../../src/agent-loop.js';
import { LlmUnavailableError } from '../../src/llm.js';
import type { LlmChatRequest, LlmChatResponse, LlmPort } from '../../src/ports.js';

const OK: LlmChatResponse = { content: null, toolCalls: [], model: 'fake' };
const REQ = { messages: [] } as unknown as LlmChatRequest;

/** Fails while `up` is false, and counts the calls that reached it. */
function flaky(state: { up: boolean; calls: number }): LlmPort {
  return {
    chat: async () => {
      state.calls += 1;
      if (!state.up) throw new LlmUnavailableError('timeout', [{ endpoint: 'primary', model: 'fake', reason: 'timeout' }]);
      return OK;
    },
  };
}

describe('team circuit breaker threshold', () => {
  it('stays closed after one slow call, so the next call still reaches the model', async () => {
    const state = { up: false, calls: 0 };
    const llm = withLlmCircuitBreaker(flaky(state), 60_000, () => 0, undefined, 3);
    await expect(llm.chat(REQ)).rejects.toThrow(LlmUnavailableError);
    state.up = true;
    await expect(llm.chat(REQ)).resolves.toBe(OK);
    expect(state.calls).toBe(2);
  });

  it('opens after three consecutive failures and then fails fast', async () => {
    const state = { up: false, calls: 0 };
    const llm = withLlmCircuitBreaker(flaky(state), 60_000, () => 0, undefined, 3);
    for (let i = 0; i < 3; i++) await expect(llm.chat(REQ)).rejects.toThrow(LlmUnavailableError);
    await expect(llm.chat(REQ)).rejects.toThrow(/circuit open/);
    expect(state.calls).toBe(3);
  });

  it('counts only consecutive failures: a success resets the count', async () => {
    const state = { up: false, calls: 0 };
    const llm = withLlmCircuitBreaker(flaky(state), 60_000, () => 0, undefined, 3);
    for (let i = 0; i < 2; i++) await expect(llm.chat(REQ)).rejects.toThrow(LlmUnavailableError);
    state.up = true;
    await llm.chat(REQ);
    state.up = false;
    for (let i = 0; i < 2; i++) await expect(llm.chat(REQ)).rejects.toThrow(LlmUnavailableError);
    state.up = true;
    await expect(llm.chat(REQ)).resolves.toBe(OK);
  });
});
