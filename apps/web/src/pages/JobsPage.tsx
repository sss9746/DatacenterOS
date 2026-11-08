import type { PageProps } from '../app/page-props';
import { Jobs } from '../components/jobs/Jobs';

/** Page 2 — "Is any training work at risk?" One card per job; the agent's decision for each comes from persisted workflow state. */
export function JobsPage({ snapshot, state, runWorkflows, runPlans, example, localPhysics }: PageProps) {
  return <Jobs snapshot={snapshot} losses={state.losses} history={state.jobHistory} details={state.actionDetails} workflows={runWorkflows} plans={runPlans} example={example} localPhysics={localPhysics} trail={state.jobTrail}/>;
}
