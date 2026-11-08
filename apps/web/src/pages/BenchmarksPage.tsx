import type { PageProps } from '../app/page-props';
import { Scoreboard } from '../components/scoreboard/Scoreboard';
import { loadRealBatch, loadRehearsalBatch } from '../data/rehearsal-batch';

/**
 * Page 5 — "Did the Nemotron planner lose less work than the baselines?" Owner: agent D.
 * Mock mode offers both fixture batches (deterministic rehearsal and the measured Nemotron batch); live mode reads
 * `state.results` only and never offers a loader.
 */
export function BenchmarksPage({ state, store, mode, onError }: PageProps) {
  const mock = mode === 'mock';
  const run = (load: typeof loadRealBatch) => () => { void load(store.client).catch((reason) => onError(String(reason))); };
  return <Scoreboard results={state.results} mode={mode}
    onLoadRehearsal={mock ? run(loadRehearsalBatch) : undefined}
    onLoadReal={mock ? run(loadRealBatch) : undefined}/>;
}
