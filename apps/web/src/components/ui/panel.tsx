import type { ReactNode } from 'react';

/** Paper panel: `--paper` fill, sage hairline, 14px radius. `eyebrow` renders the provenance label above the H2. */
export function Panel({ id, title, detail, children, className = '', eyebrow }: { id?: string; title: string; detail?: ReactNode; children: ReactNode; className?: string; eyebrow?: ReactNode }) {
  const headingId = `${id ?? title.toLowerCase().replaceAll(' ', '-')}-heading`;
  return <section id={id} className={`panel ${className}`} aria-labelledby={headingId}><div className="panel-heading"><div className="panel-title">{eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}<h2 id={headingId}>{title}</h2></div>{detail}</div>{children}</section>;
}

/** Badge tones (DESIGN-DIRECTION §5): neutral · simulated · real · nemotron · code · unknown · warning · danger · blocked · example · mock · agent (alias of nemotron). */
export function Badge({ children, tone = 'neutral', className = '' }: { children: ReactNode; tone?: string; className?: string }) {
  const dot = tone === 'real' || tone === 'nemotron';
  return <span className={`badge badge-${tone} ${className}`.trim()}>{dot && <i className="badge-dot" aria-hidden="true"/>}{children}</span>;
}

/** Uppercase 11.5px section label ("SIMULATED CLUSTER", "AGENT ROOM"). */
export function Eyebrow({ children, className = '', as: Tag = 'span' }: { children: ReactNode; className?: string; as?: 'span' | 'p' | 'div' }) {
  return <Tag className={`eyebrow ${className}`.trim()}>{children}</Tag>;
}

/** Hero number plus label: "61/64" over "GPUs ready". `tone` adds warning/danger colour to the value. */
export function Stat({ value, label, tone, className = '', size = 'default' }: { value: ReactNode; label: ReactNode; tone?: 'warning' | 'danger' | 'muted'; className?: string; size?: 'default' | 'sm' }) {
  return <div className={`stat ${size === 'sm' ? 'stat-sm' : ''} ${tone ? `stat-${tone}` : ''} ${className}`.trim()}><strong className="stat-value">{value}</strong><span className="stat-label">{label}</span></div>;
}

export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return <div className="empty"><strong>{title}</strong><p>{children}</p></div>;
}
