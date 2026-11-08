import { CircleAlert, Link2 } from 'lucide-react';
import type { Incident } from '@dcos/contracts';
import type { Evidence } from '@dcos/db-client';
import { Panel, Badge, Empty } from '../ui/panel';
export function Incidents({ incidents, evidence, example }: { incidents: Incident[]; evidence: Evidence | null; example: boolean }) {
  const active = incidents.filter((row) => row.state !== 'resolved');
  return <Panel title="Incidents" id="incidents" detail={<Badge tone={active.length ? 'warning' : 'neutral'}>{active.length} open</Badge>}>
    {example && <p className="example-note">Scripted UI examples · no model ran</p>}
    {incidents.length === 0 ? <Empty title="No incidents reported">Incident records appear when the orchestrator groups and diagnoses signals. A fault alone does not create an agent diagnosis.</Empty> : <div className="incident-list">{incidents.map((incident) => {
      const links = evidence?.links.filter((link) => link.incident_id === incident.incident_id) ?? [];
      return <article className="incident" key={incident.incident_id}><div className="incident-meta"><span><CircleAlert size={14}/>{incident.incident_id}</span><Badge tone={incident.severity === 'critical' ? 'danger' : 'warning'}>{incident.severity}</Badge></div><h3>{incident.title}</h3><p>{incident.hypothesis ?? 'Waiting for a diagnosis.'}</p><div className="resource-links">{links.length ? links.map((link) => <span key={`${link.link_kind}-${link.linked_id}`} title={link.reason}><Link2 size={11}/>{link.linked_id}</span>) : <span>No linked evidence yet</span>}</div><div className="incident-state"><span>{incident.state}</span><span>{Math.round(incident.confidence * 100)}% confidence{example ? ' · example' : ''}</span></div></article>;
    })}</div>}
  </Panel>;
}
