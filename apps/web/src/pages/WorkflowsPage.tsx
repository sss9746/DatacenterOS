import type { PageProps } from '../app/page-props';
import { WorkflowBoard } from '../components/workflows/WorkflowBoard';
import { Ledger } from '../components/ledger/Ledger';
import { ModelAssumptions } from '../components/simulation/ModelAssumptions';

/** Page 4 — "Where is each recovery, and what was blocked?" Owner: agent D. Stub renders board + ledger + model. */
export function WorkflowsPage({ state, snapshot, runWorkflows, runPlans, example, mode, now }: PageProps) {
  return <>
    <WorkflowBoard workflows={runWorkflows} plans={runPlans} events={state.events} actionDetails={state.actionDetails} incidents={state.incidents} snapshot={snapshot} example={example} mode={mode} nowUnixMs={now}/>
    <Ledger actions={state.actions} details={state.actionDetails} simTimeMs={snapshot.clock.sim_time_ms}/>
    <ModelAssumptions snapshot={snapshot}/>
  </>;
}
