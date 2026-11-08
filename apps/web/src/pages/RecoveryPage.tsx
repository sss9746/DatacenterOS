import type { PageProps } from '../app/page-props';
import { Incidents } from '../components/incidents/Incidents';
import { Feed } from '../components/feed/Feed';

/** Page 3 — "What did the agents see, decide and do?" Owner: agent B. Stub renders incidents + the feed. */
export function RecoveryPage({ state, example }: PageProps) {
  return <div className="activity-grid"><Incidents incidents={state.incidents} evidence={state.evidence} example={example}/><Feed events={state.events} example={example}/></div>;
}
