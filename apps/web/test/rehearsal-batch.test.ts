import { describe, expect, it } from 'vitest';
import { createMockClient, connect } from '@dcos/db-client';
import { provenanceConflicts, summarizeResults } from '@dcos/evaluation';
import type { EvaluationResult } from '@dcos/contracts';
import { REHEARSAL_BATCH, loadRehearsalBatch } from '../src/data/rehearsal-batch';

describe('deterministic rehearsal batch fixture', () => {
  it('is one consistent, fully-provenanced 12 × 3 batch with no model calls', () => {
    const rows = REHEARSAL_BATCH.rows;
    expect(rows).toHaveLength(36);
    expect(provenanceConflicts(rows)).toEqual([]);
    expect(rows.every((row) => row.provenance?.batch_id === 'rehearsal-fixed12-nollm')).toBe(true);
    const nemotron = rows.filter((row) => row.policy === 'nemotron');
    expect(nemotron).toHaveLength(12);
    expect(nemotron.every((row) => row.provenance!.model_enabled === false && row.provenance!.live_model_responses === 0 && row.provenance!.cache_hits === 0)).toBe(true);
    expect(summarizeResults(rows).matchedCount).toBe(12);
  });
  it('round-trips through the validating mock client unchanged, provenance included', async () => {
    const client = createMockClient();
    expect(await loadRehearsalBatch(client)).toBe(36);
    const received = await new Promise<EvaluationResult[]>((resolve) => { const stop = client.onEvaluation((results) => { if (results.length === 36) { resolve(results); queueMicrotask(stop); } }); });
    const key = (row: EvaluationResult) => `${row.scenario_id}|${row.policy}|${row.seed}`;
    const byKey = new Map(received.map((row) => [key(row), row]));
    for (const row of REHEARSAL_BATCH.rows) expect(byKey.get(key(row))).toEqual(row);
    client.close();
  });
  it('is never published to a live client', async () => {
    const fake = { mode: 'live', publishEvaluationResult: async () => { throw new Error('must not be called'); } } as unknown as Awaited<ReturnType<typeof connect>>;
    await expect(loadRehearsalBatch(fake)).rejects.toThrow(/never published to a live database/);
  });
});
