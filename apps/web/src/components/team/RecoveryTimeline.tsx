import { ROLE_LABEL, type Chapter, type TeamRoundView } from './team-view';

const CALL_WORD: Record<string, string> = { running: 'running', ok: 'ok', timeout: 'timed out', rejected: 'rejected', failed: 'failed' };

/**
 * Ordinal chapters for the whole workflow. Only inside a team round are bars drawn to scale, on that round's own wall
 * clock; between chapters there is no time axis (team calls use wall time, actions use sim time).
 */
export function RecoveryTimeline({ chapters, nowRoundMs }: { chapters: Chapter[]; nowRoundMs?: number | null }) {
  if (!chapters.length) return null;
  return <section className="rt" aria-labelledby="rt-heading">
    <div className="rt-head">
      <h4 id="rt-heading">Recovery so far</h4>
      <span className="rt-meta">Order from persisted records; not a time axis. Bars are to scale only inside a round (wall time).</span>
    </div>
    <ol className="rt-list">
      {chapters.map((c, i) => <li key={c.key} className={`rt-ch rt-ch-${c.kind} rt-tone-${c.tone}`}>
        <span className="rt-num" aria-hidden="true">{i + 1}</span>
        <div className="rt-body">
          <p className="rt-title"><strong>{c.title}</strong>{c.simMs !== null && <span className="rt-at">at {simText(c.simMs)}</span>}</p>
          <p className="rt-detail">{c.detail}</p>
          {c.round && <RoundBars round={c.round} nowRoundMs={c.round.status === 'running' ? nowRoundMs ?? null : null}/>}
        </div>
      </li>)}
    </ol>
  </section>;
}

const simText = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s sim` : `${s} s sim`;
};

/** Per-call bars on the round's own wall clock (v2 only). A v1 trace shows the call count and total wall time, nothing more. */
function RoundBars({ round, nowRoundMs }: { round: TeamRoundView; nowRoundMs: number | null }) {
  if (!round.calls.length) return <p className="rt-nobars">{round.callsUsed} model calls in {(round.wallMs / 1000).toFixed(1)} s wall · per-call timing not recorded</p>;
  const end = Math.max(round.wallMs, round.budget.roundMs, ...round.calls.map((c) => c.endedMs ?? nowRoundMs ?? c.startedMs));
  const scale = (ms: number) => `${Math.max(0, Math.min(100, (ms / end) * 100))}%`;
  return <figure className="rt-bars">
    <figcaption className="sr-only">Model calls in round {round.label}, wall time from round start</figcaption>
    <ul>
      {round.calls.map((c, i) => {
        const stop = c.endedMs ?? nowRoundMs ?? round.wallMs;
        const width = Math.max(0, stop - c.startedMs);
        return <li key={`${c.role}-${c.startedMs}-${i}`} className={`rt-call rt-call-${c.status}`}>
          <span className="rt-call-role">{ROLE_LABEL[c.role]}</span>
          <span className="rt-call-track" aria-hidden="true"><span className="rt-call-bar" style={{ left: scale(c.startedMs), width: scale(width) }}/></span>
          <span className="rt-call-meta">{c.phase.replaceAll('_', ' ')} · {CALL_WORD[c.status]} · {(c.startedMs / 1000).toFixed(1)}–{c.endedMs === null ? 'now' : `${(c.endedMs / 1000).toFixed(1)} s`}</span>
        </li>;
      })}
    </ul>
    <p className="rt-axis"><span>0 s</span><span>{(end / 1000).toFixed(0)} s wall (round budget {(round.budget.roundMs / 1000).toFixed(0)} s)</span></p>
  </figure>;
}
