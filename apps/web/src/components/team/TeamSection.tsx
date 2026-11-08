import { useMemo, useState } from 'react';
import type { WorkflowView } from '../workflows/workflow-view';
import { RecoveryTimeline } from './RecoveryTimeline';
import { RoundPicker, TeamStage, type RecordedInfo } from './TeamStage';
import { TeamTranscript } from './TeamTranscript';
import { buildChapters, readOperatorJobs, readRecovery, readTeam } from './team-view';

export interface TeamSectionProps {
  view: WorkflowView;
  mode: 'mock' | 'live';
  example: boolean;
  recorded: RecordedInfo | null;
}

/** Team stage + transcript for the selected workflow, then the recovery timeline. Follows the latest round until the viewer picks one. */
export function TeamSection({ view, mode, example, recorded }: TeamSectionProps) {
  const state = view.workflow.state;
  const team = useMemo(() => readTeam(state), [state]);
  const chapters = useMemo(() => buildChapters({
    team, actions: view.actions, resumed: view.resumed, verification: view.verification,
    recovery: readRecovery(state), operatorJobs: readOperatorJobs(state), stage: view.workflow.stage, escalationReason: view.escalationReason,
  }), [team, view, state]);
  const [picked, setPicked] = useState<string | null>(null);
  const round = team ? (team.rounds.find((r) => r.key === picked) ?? team.rounds.at(-1)!) : null;
  return <section className="team-section" aria-label="Agent team">
    {round && team ? <>
      <RoundPicker rounds={team.rounds} selected={round.key} onSelect={setPicked} dropped={team.dropped}/>
      <div className="team-grid">
        <TeamStage round={round} mode={mode} example={example} recorded={recorded}/>
        <TeamTranscript round={round}/>
      </div>
    </> : <div className="team-empty" role="note">
      <strong>No team round recorded for this workflow</strong>
      <p>Single-agent mode or agent not connected. When the agent team runs, its Cooling, Workload and Lead messages appear here as the round records them.</p>
    </div>}
    <RecoveryTimeline chapters={chapters}/>
  </section>;
}
