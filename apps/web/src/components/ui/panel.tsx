import type { ReactNode } from 'react';
export function Panel({ id, title, detail, children, className = '' }: { id?: string; title: string; detail?: ReactNode; children: ReactNode; className?: string }) {
  const headingId = `${id ?? title.toLowerCase().replaceAll(' ', '-')}-heading`;
  return <section id={id} className={`panel ${className}`} aria-labelledby={headingId}><div className="panel-heading"><h2 id={headingId}>{title}</h2>{detail}</div>{children}</section>;
}
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return <div className="empty"><strong>{title}</strong><p>{children}</p></div>;
}
