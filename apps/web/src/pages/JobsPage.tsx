import type { PageProps } from '../app/page-props';
import { Jobs } from '../components/jobs/Jobs';

/** Page 2 — "Is any training work at risk?" Owner: agent C. Stub renders the existing Jobs panel. */
export function JobsPage({ snapshot, state }: PageProps) {
  return <Jobs snapshot={snapshot} losses={state.losses} history={state.jobHistory} details={state.actionDetails}/>;
}
