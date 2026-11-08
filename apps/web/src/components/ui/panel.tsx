import type { ReactNode } from 'react';
export function Panel({ id, title, detail, children, className = '' }: { id?: string; title: string; detail?: ReactNode; children: ReactNode; className?: string }) {
  const headingId = `${id ?? title.toLowerCase().replaceAll(' ', '-')}-heading`;
  return <section id={id} className={`panel ${className}`} aria-labelledby={headingId}><div className="panel-heading"><h2 id={headingId}>{title}</h2>{detail}</div>{children}</section>;
}
/** Tones with CSS in styles.css: neutral, warning, danger, agent, real, simulated, nemotron, code, example, mock, blocked. */
export type BadgeTone = 'neutral' | 'warning' | 'danger' | 'agent' | 'real' | 'simulated' | 'nemotron' | 'code' | 'example' | 'mock' | 'blocked' | (string & {});
export function Badge({ children, tone = 'neutral', title }: { children: ReactNode; tone?: BadgeTone; title?: string }) {
  return <span className={`badge badge-${tone}`} title={title}>{children}</span>;
}
export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return <div className="empty"><strong>{title}</strong><p>{children}</p></div>;
}
/** Uppercase 11px muted label above a group or a number. */
export function Eyebrow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`eyebrow ${className}`}>{children}</span>;
}
/** Hero number + label. `tone` colours the value; `size="sm"` for dense rows. */
export function Stat({ value, label, tone, size, title, className = '' }: { value: ReactNode; label: ReactNode; tone?: 'warning' | 'danger' | 'muted'; size?: 'sm'; title?: string; className?: string }) {
  return <div className={`stat ${tone ? `stat-${tone}` : ''} ${size === 'sm' ? 'stat-sm' : ''} ${className}`} title={title}><span className="stat-value">{value}</span><span className="stat-label">{label}</span></div>;
}
/** Small inline pill for an id, a count or a status word. */
export function Chip({ children, title, className = '' }: { children: ReactNode; title?: string; className?: string }) {
  return <span className={`chip ${className}`} title={title}>{children}</span>;
}
