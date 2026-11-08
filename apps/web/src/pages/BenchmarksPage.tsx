import type { PageProps } from '../app/page-props';
import { Scoreboard } from '../components/scoreboard/Scoreboard';
import { loadRehearsalBatch } from '../data/rehearsal-batch';

/** Page 5 — "Did the Nemotron planner lose less work than the baselines?" Owner: agent D (adds `loadRealBatch`). */
export function BenchmarksPage({ state, store, mode, onError }: PageProps) {
  return <Scoreboard results={state.results} mode={mode}
    onLoadRehearsal={mode === 'mock' ? () => { void loadRehearsalBatch(store.client).catch((reason) => onError(String(reason))); } : undefined}/>;
}
