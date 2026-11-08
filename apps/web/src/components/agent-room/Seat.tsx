import { Check } from 'lucide-react';
import { Badge } from '../ui/panel';
import type { SeatInfo } from './seat-of';
import type { SeatState } from './room-view';

const STATE_LABEL: Record<SeatState, string> = { idle: 'idle', thinking: 'working', done: 'has spoken' };

export function Seat({ info, state, count }: { info: SeatInfo; state: SeatState; count: number }) {
  const tone = info.actor === 'nemotron' ? 'nemotron' : info.actor === 'code' ? 'code' : 'unknown';
  return (
    <li className={`ar-seat ar-seat-${tone} is-${state}`} aria-label={`${info.name}, ${info.role}, ${STATE_LABEL[state]}${count ? `, ${count} message${count === 1 ? '' : 's'}` : ''}`}>
      <span className="ar-avatar" aria-hidden="true"><span className="ar-avatar-initial">{info.initial}</span>{state === 'done' && <span className="ar-avatar-check"><Check size={10} strokeWidth={3}/></span>}</span>
      <span className="ar-seat-name">{info.name}</span>
      <Badge tone={tone}>{info.actor === 'nemotron' ? <><span className="ar-badge-full">NVIDIA Nemotron</span><span className="ar-badge-short">Nemotron</span></> : info.actor === 'code' ? 'code' : 'unattributed'}</Badge>
      <span className="ar-seat-role">{info.role}</span>
    </li>
  );
}
