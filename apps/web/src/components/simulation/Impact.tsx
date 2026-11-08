import type { ObservedSnapshot } from '@dcos/contracts';
import type { ActionDetail } from '@dcos/db-client';
import { number } from '../../lib/utils';
import { clusterImpact, impactStats } from './impact-model';
import './simulation-view.css';

type Props = {
  snapshot: ObservedSnapshot; details: ActionDetail[];
  /** Render only these stat ids (display order is kept); omit for all five. */
  ids?: readonly string[];
  label?: string;
  className?: string;
};

/** Plain-word tiles: what the faults cost and what the agent protected. Every number is derived from observed data. */
export function Impact({ snapshot, details, ids, label = 'Cluster impact summary (simulated)', className = '' }: Props) {
  const all = impactStats(clusterImpact(snapshot, details));
  const stats = ids ? all.filter((stat) => ids.includes(stat.id)) : all;
  return <div className={`cluster-impact ${className}`} role="list" aria-label={label}>
    {stats.map((stat) => <div key={stat.id} role="listitem" className={`stat is-${stat.tone}`} title={stat.title}>
      <span className="stat-value">{number(stat.value)}</span>
      <span className="stat-label">{stat.label}</span>
    </div>)}
  </div>;
}
