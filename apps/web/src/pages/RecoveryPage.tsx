import type { PageProps } from '../app/page-props';
import { AgentRoom } from '../components/agent-room/AgentRoom';
import { Incidents, RecoveredEvidence } from '../components/incidents/Incidents';

/**
 * Page 3 — "What did the agents see, decide and do?" Owner: agent B.
 * Left: the Agent room (specialist seats, one chat thread per workflow, takeover dividers, cross-agent messages).
 * Right: one explained card per incident, then the facts the agents recovered (takeovers, verification, blocked actions).
 * The full event log lives on the Workflows page.
 */
export function RecoveryPage({ state, snapshot, runWorkflows, example, mode, now }: PageProps) {
  return <div id="activity" className="recovery-grid">
    <AgentRoom events={state.events} workflows={runWorkflows} incidents={state.incidents} nowUnixMs={now} example={example} mode={mode}/>
    <div className="recovery-side">
      <Incidents incidents={state.incidents} evidence={state.evidence} workflows={runWorkflows} events={state.events} actions={state.actionDetails} snapshot={snapshot} example={example} mode={mode}/>
      <RecoveredEvidence workflows={runWorkflows} events={state.events} actions={state.actionDetails} example={example}/>
    </div>
  </div>;
}
