import { Badge } from '../ui/panel';
import { ROLE_LABEL, partyLabel, type TeamMessageView, type TeamRoundView } from './team-view';

const KIND_LABEL: Record<TeamMessageView['kind'], string> = {
  question: 'question', answer: 'answer', finding: 'finding', objection: 'objection', cover: 'cover', decision: 'proposed choice', unknown: 'kind not recorded',
};

const partyClass = (p: string) => `tt-party tt-party-${p}`;
const fmtT = (ms: number) => `+${(ms / 1000).toFixed(1)} s`;

/**
 * The round as it was recorded: every persisted message in order, full text, evidence and resource ids. Findings,
 * answers and covers are CLAIMs. Covers appear where they happened; questions nobody answered say so.
 */
export function TeamTranscript({ round }: { round: TeamRoundView }) {
  const coverByMessage = new Map(round.covers.filter((c) => c.messageId).map((c) => [c.messageId!, c]));
  const unplaced = round.covers.filter((c) => !c.messageId);
  return <section className="tt" aria-labelledby={`tt-${round.key}-h`}>
    <div className="tt-head">
      <h4 id={`tt-${round.key}-h`}>Transcript · round {round.label}</h4>
      <span className="tt-meta">{round.messages.length} {round.messages.length === 1 ? 'message' : 'messages'}{round.timing === 'not recorded' ? ' · timing not recorded' : ''}</span>
    </div>
    <p className="tt-note">Findings, answers and covers are model claims and can be wrong. The code gate checks the choice; it does not check the claims.</p>
    <ol className="tt-list" aria-live="polite" aria-relevant="additions" aria-label={`Messages in round ${round.label}`}>
      {round.messages.length === 0 && <li className="tt-empty">{round.status === 'running' ? 'No message recorded yet; the round is running.' : 'This round recorded no messages.'}</li>}
      {unplaced.map((c) => <li key={`cover-${c.failedRole}`} className="tt-event tt-event-cover">{ROLE_LABEL[c.failedRole]} {c.cause} — {ROLE_LABEL[c.coveredBy]} covered</li>)}
      {round.messages.map((m) => {
        const cover = coverByMessage.get(m.id);
        return <li key={m.id} className={`tt-msg tt-kind-${m.kind}`} data-message-id={m.id}>
          {cover && <p className="tt-event tt-event-cover">{ROLE_LABEL[cover.failedRole]} {cover.cause} — {ROLE_LABEL[cover.coveredBy]} covered</p>}
          <div className="tt-line">
            <span className="tt-route"><span className={partyClass(m.from)}>{partyLabel(m.from)}</span><span aria-hidden="true"> → </span><span className="sr-only"> to </span><span className={partyClass(m.to)}>{partyLabel(m.to)}</span></span>
            <span className="tt-kind">{KIND_LABEL[m.kind]}</span>
            {m.claim && <Badge tone="warning" title="A model claim; it can be wrong">CLAIM</Badge>}
            {m.from === 'supervisor' && <Badge tone="code">CODE</Badge>}
            {m.consumedByRecipient === false && <span className="tt-unconsumed" title={`${partyLabel(m.to)}'s next model input did not contain this message`}>not consumed</span>}
            {m.tMs !== null && <span className="tt-t">{fmtT(m.tMs)}</span>}
          </div>
          <p className="tt-summary">{m.summary || <em>no text recorded</em>}</p>
          {(m.evidenceIds.length > 0 || m.resourceIds.length > 0) && <div className="tt-ids">
            {m.evidenceIds.length > 0 && <p><span className="tt-ids-label">Evidence</span>{m.evidenceIds.map((id) => <code key={id}>{id}</code>)}</p>}
            {m.resourceIds.length > 0 && <p><span className="tt-ids-label">Resources</span>{m.resourceIds.map((id) => <code key={id}>{id}</code>)}</p>}
          </div>}
          <p className="tt-foot">
            {m.consumedBy.length ? `Read by ${m.consumedBy.map((r) => ROLE_LABEL[r]).join(', ')}` : m.to === 'supervisor' ? 'Read by code' : 'Read by no agent'}
            {m.replyTo && ` · reply to ${m.replyTo.split(':').at(-1)}`}
            {m.unanswered && ' · no answer recorded in this round'}
            <span className="tt-id"> · {m.id.split(':').at(-1)}</span>
          </p>
        </li>;
      })}
    </ol>
  </section>;
}
