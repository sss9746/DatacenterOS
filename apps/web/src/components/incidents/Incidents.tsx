import { Link2 } from 'lucide-react';
import type { Incident } from '@dcos/contracts';
import type { Evidence } from '@dcos/db-client';
import { Panel, Badge, Empty } from '../ui/panel';
import './incidents.css';

/** One plain-English status pill per card, from the persisted incident state only. */
const STATUS: Record<Incident['state'], { label: string; tone: string }> = {
  open: { label: 'Investigating', tone: 'warning' },
  investigating: { label: 'Investigating', tone: 'warning' },
  mitigating: { label: 'Recovering', tone: 'neutral' },
  monitoring: { label: 'Recovering', tone: 'neutral' },
  resolved: { label: 'Recovered', tone: 'agent' },
  escalated: { label: 'Needs a human', tone: 'danger' },
};

/**
 * Default-screen incident cards: title, one status pill, one line of detail. Ids, severity, confidence and linked
 * evidence stay on the record but live inside the card's "More" disclosure, so the default view carries no numbers.
 */
export function Incidents({ incidents, evidence, example }: { incidents: Incident[]; evidence: Evidence | null; example: boolean }) {
  const active = incidents.filter((row) => row.state !== 'resolved');
  return <Panel title="Incidents" id="incidents" detail={<Badge tone={active.length ? 'warning' : 'neutral'}>{active.length ? `${active.length} open` : 'none open'}</Badge>}>
    {example && <p className="example-note">Scripted UI examples · no model ran</p>}
    {incidents.length === 0 ? <Empty title="No incidents reported">Incident records appear when the orchestrator groups and diagnoses signals. A fault alone does not create an agent diagnosis.</Empty> : <div className="incident-list">{incidents.map((incident) => {
      const links = evidence?.links.filter((link) => link.incident_id === incident.incident_id) ?? [];
      const status = STATUS[incident.state] ?? { label: incident.state, tone: 'neutral' };
      return <article className={`incident incident-${incident.severity}`} key={incident.incident_id}>
        <div className="incident-head"><h3>{incident.title}</h3><Badge tone={status.tone}>{status.label}</Badge></div>
        <p className="incident-line">{incident.hypothesis ?? 'Waiting for a diagnosis.'}</p>
        <details className="incident-more">
          <summary>More</summary>
          <dl className="incident-facts">
            <div><dt>Incident</dt><dd><code>{incident.incident_id}</code></dd></div>
            <div><dt>Severity</dt><dd>{incident.severity}</dd></div>
            <div><dt>State</dt><dd>{incident.state}</dd></div>
            <div><dt>Confidence</dt><dd>{Math.round(incident.confidence * 100)}%{example ? ' · example' : ''}</dd></div>
          </dl>
          <div className="resource-links">{links.length ? links.map((link) => <span key={`${link.link_kind}-${link.linked_id}`} title={link.reason}><Link2 size={11} aria-hidden="true"/>{link.linked_id}</span>) : <span>No linked evidence yet</span>}</div>
        </details>
      </article>;
    })}</div>}
  </Panel>;
}
