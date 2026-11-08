import { ArrowRight } from 'lucide-react';
import { Badge } from '../ui/panel';
import { seatInfo } from './seat-of';
import type { Bubble as BubbleModel, Divider as DividerModel } from './room-view';
import type { TeamKind } from './team-message';
import { duration } from '../../lib/utils';

const actorTone = (actor: string | undefined): 'nemotron' | 'code' | 'unknown' => actor === 'nemotron' ? 'nemotron' : actor === 'code' ? 'code' : 'unknown';
const kindTone = (kind: TeamKind): string => kind === 'objection' ? 'blocked' : kind === 'cover' ? 'warning' : kind === 'decision' ? 'agent' : 'neutral';
/** Model-written content that code did not check: shown as a claim, never as a fact. */
const isClaim = (kind: TeamKind): boolean => kind === 'finding' || kind === 'answer' || kind === 'cover';

/**
 * One persisted event as a chat bubble. Default state: one header line (who · process · actor), a body clamped to two
 * lines, and a single "more" toggle. Expanded: the full text, the stage/time line, and the tool chips (args/result).
 */
export function Bubble({ bubble, fresh, handoffFresh, showExample, showHandoff = true }: { bubble: BubbleModel; fresh: boolean; handoffFresh: boolean; showExample: boolean; showHandoff?: boolean }) {
  const seat = seatInfo(bubble.seat);
  const tone = actorTone(seat.actor ?? undefined);
  // Seat handoffs belong to the home thread; the shared Agents lane mixes workflows, so it does not draw them.
  const target = showHandoff && bubble.handoffTo ? seatInfo(bubble.handoffTo) : null;
  const process = bubble.process;
  const actorBadge = <Badge tone={tone}>{seat.actor === 'nemotron' ? 'NEMOTRON' : seat.actor === 'code' ? 'CODE' : 'UNATTRIBUTED'}</Badge>;
  const m = bubble.message;
  const tools = bubble.toolCalls.length;
  const moreLabel = tools ? `more · ${tools} tool${tools === 1 ? '' : 's'}` : 'more';
  return (
    <li className={`ar-msg ar-msg-${tone}${fresh ? ' is-new' : ''}${bubble.blocked ? ' is-blocked' : ''}${m ? ` ar-msg-x ar-kind-${m.kind}${m.notConsumed ? ' is-unconsumed' : ''}` : ''}`} data-seat={bubble.seat} data-thread={bubble.threadId}>
      <span className="ar-msg-avatar" aria-hidden="true">{seat.initial}</span>
      <div className="ar-bubble">
        <div className="ar-msg-meta">
          {m ? (
            <strong className="ar-msg-seat ar-msg-route"><span>{m.fromLabel}</span> <ArrowRight size={11} aria-hidden="true"/><span className="sr-only">to</span> <span>{m.toLabel}</span></strong>
          ) : (
            <strong className="ar-msg-seat">{seat.name}</strong>
          )}
          {!m && process && <span className="ar-msg-process">{process}</span>}
          {m && <Badge tone={kindTone(m.kind)}>{m.kind}</Badge>}
          {m && isClaim(m.kind) && <Badge tone="neutral" title="Model-written finding; deterministic safety still decides">CLAIM</Badge>}
          {m?.notConsumed && <span className="ar-msg-unread">not consumed</span>}
          {actorBadge}
          {showExample && bubble.example && <Badge tone="example">EXAMPLE</Badge>}
          {bubble.blocked && <Badge tone="blocked">BLOCKED</Badge>}
        </div>
        <p className="ar-msg-text">{m ? m.text : bubble.summary}</p>
        <details className="ar-more">
          <summary>{moreLabel}</summary>
          <p className="ar-msg-detail">
            {m ? <>team message from the {seat.name} seat{process ? ` · ${process}` : ''}{m.consumption ? ` · ${m.consumption}` : ''} · </> : null}
            <span className="ar-msg-stage">{bubble.stage} · t+{duration(bubble.simTimeMs)}</span>
          </p>
          {tools > 0 && (
            <ul className="ar-tools" aria-label="Tool calls">
              {bubble.toolCalls.map((call, i) => (
                <li key={`${bubble.id}-${i}`}>
                  <details className={`ar-tool ar-tool-${actorTone(call.actor)}`}>
                    <summary><i className="ar-dot" aria-hidden="true"/><code>{call.tool}</code><span className="sr-only">, called by {call.actor ?? 'an unrecorded actor'}</span></summary>
                    <dl className="ar-tool-body"><dt>args</dt><dd>{call.args_summary || '—'}</dd><dt>result</dt><dd>{call.result_summary || '—'}</dd></dl>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </details>
      </div>
      {target && (
        <div className={`ar-handoff${handoffFresh ? ' is-travelling' : ''}`} aria-label={`Handoff from ${seat.name} to ${target.name}`}>
          <span className="ar-handoff-track" aria-hidden="true"><i className="ar-handoff-dot"/></span>
          <span className="ar-handoff-label">{seat.name} <ArrowRight size={10} aria-hidden="true"/> {target.name}</span>
        </div>
      )}
    </li>
  );
}

export function Divider({ divider }: { divider: DividerModel }) {
  // A plain list item (no separator role: not an allowed child of a list); the text itself is the accessible content.
  return <li className="ar-divider"><span>{divider.text}</span></li>;
}
