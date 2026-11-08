import type { ObservedSnapshot } from '@dcos/contracts';
import type { ActionDetail } from '@dcos/db-client';
import { number } from '../../lib/utils';
import { clusterImpact, impactStats } from './impact-model';
import './simulation-view.css';

/** Five plain-word tiles: what the faults cost and what the agent protected. Every number is derived from observed data. */
export function Impact({ snapshot, details }: { snapshot: ObservedSnapshot; details: ActionDetail[] }) {
  const stats = impactStats(clusterImpact(snapshot, details));
  return <div className="cluster-impact" role="list" aria-label="Cluster impact summary (simulated)">
    {stats.map((stat) => <div key={stat.id} role="listitem" className={`stat is-${stat.tone}`} title={stat.title}>
      <span className="stat-value">{number(stat.value)}</span>
      <span className="stat-label">{stat.label}</span>
    </div>)}
  </div>;
}
