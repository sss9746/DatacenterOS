import { ArrowRight } from 'lucide-react';
import { Badge } from '../ui/panel';
import { seatInfo } from './seat-of';
import type { Bubble as BubbleModel, Divider as DividerModel } from './room-view';
import { duration } from '../../lib/utils';

const actorTone = (actor: string | undefined): 'nemotron' | 'code' | 'unknown' => actor === 'nemotron' ? 'nemotron' : actor === 'code' ? 'code' : 'unknown';

export function Bubble({ bubble, fresh, handoffFresh }: { bubble: BubbleModel; fresh: boolean; handoffFresh: boolean }) {
  const seat = seatInfo(bubble.seat);
  const tone = actorTone(seat.actor ?? undefined);
  const target = bubble.handoffTo ? seatInfo(bubble.handoffTo) : null;
  return (
    <li className={`ar-msg ar-msg-${tone}${fresh ? ' is-new' : ''}${bubble.blocked ? ' is-blocked' : ''}`} data-seat={bubble.seat}>
      <span className="ar-msg-avatar" aria-hidden="true">{seat.initial}</span>
      <div className="ar-bubble">
        <div className="ar-msg-meta">
          <strong className="ar-msg-seat">{seat.name}</strong>
          <Badge tone={tone}>{seat.actor === 'nemotron' ? 'NVIDIA Nemotron' : seat.actor === 'code' ? 'code' : 'unattributed'}</Badge>
          {bubble.example && <Badge tone="example">EXAMPLE</Badge>}
          {bubble.blocked && <Badge tone="blocked">BLOCKED</Badge>}
          <span className="ar-msg-stage">{bubble.stage} · t+{duration(bubble.simTimeMs)}</span>
        </div>
        <p className="ar-msg-text">{bubble.summary}</p>
        {bubble.toolCalls.length > 0 && (
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
  return <li className="ar-divider" role="separator" aria-label={divider.text}><span>{divider.text}</span></li>;
}
