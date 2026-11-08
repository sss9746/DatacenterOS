import type { EvaluationResult } from '@dcos/contracts';
import type { DbClient } from '@dcos/db-client';
import batch from './fixtures/rehearsal-fixed12-nollm.json';

/**
 * A measured, deterministic-only rehearsal batch (12 fixed scenarios × 3 policies) produced by the checked-in R6 team
 * adapter with `--no-llm`. Every row carries provenance with `model_enabled: false` on the Nemotron-policy rows, so the
 * scoreboard labels them as a deterministic planner. Mock preview only: it is published into the in-memory mock client
 * on request and is never sent to a live database. The real Nemotron batch replaces it at M3.
 */
export const REHEARSAL_BATCH = batch as unknown as { description: string; command: string; manifest: Record<string, unknown>; rows: EvaluationResult[] };

/** Publishes the rehearsal rows through the client's normal (validating) evaluation API. Refuses live clients. */
export async function loadRehearsalBatch(client: DbClient): Promise<number> {
  if (client.mode !== 'mock') throw new Error('The rehearsal batch is a mock preview and is never published to a live database.');
  for (const row of REHEARSAL_BATCH.rows) await client.publishEvaluationResult(row);
  return REHEARSAL_BATCH.rows.length;
}
