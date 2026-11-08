import { useState } from 'react';
import type { ActionStatus } from '@dcos/contracts';
import { ShieldAlert } from 'lucide-react';
import { Panel, Badge, Empty } from '../ui/panel';
import { duration } from '../../lib/utils';
const reasons: Record<string, string> = {
  DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT: 'The destination rack has too little thermal headroom for this placement.',
  DEST_POWER_HEADROOM_INSUFFICIENT: 'The destination does not have enough available power.',
  DEST_GPU_UNHEALTHY: 'A destination GPU is unhealthy.', DEST_GPU_BUSY: 'A destination GPU is already allocated.',
  DEST_GPU_LEASED: 'Another action has reserved a destination GPU.', DEST_GPU_COUNT_INSUFFICIENT: 'There are not enough eligible GPUs for the whole job.',
  DEST_NOT_COMPATIBLE: 'The destination is incompatible with this job.', CHECKPOINT_NOT_ACCESSIBLE: 'The checkpoint cannot be read from this destination.',
  NO_COMPLETED_CHECKPOINT: 'A completed checkpoint is required before restarting.', JOB_NOT_PREEMPTIBLE: 'This job cannot be moved voluntarily.',
  CHECKPOINT_UNSUPPORTED: 'This job does not support checkpointing.', STALE_DECISION_EPOCH: 'The cluster changed after the plan was made. A fresh plan is needed.',
  STALE_RESOURCE_VERSION: 'A resource changed after the plan was made.', CONFLICTING_ACTION: 'Another action conflicts with this command.', EVIDENCE_STALE: 'The supporting evidence is too old.',
  UNSUPPORTED_OPERATION: 'This operation is not supported.', CORDON_IS_NOT_REPAIR: 'Cordoning a GPU does not repair it.', REAL_GPU_NOT_ALLOCATABLE: 'The real Brev GPU is observation-only and cannot be allocated.',
};
export const actionLabel = (action: ActionStatus) => action.status === 'failed' && action.reason_code === 'SAFETY_REJECTED' ? 'BLOCKED' : action.status.replaceAll('_', ' ');
export const reasonText = (code: string) => reasons[code] ?? code.replaceAll('_', ' ').toLowerCase();
export function Ledger({ actions }: { actions: ActionStatus[] }) {
  const [filter, setFilter] = useState('all');
  const filtered = [...actions].reverse().filter((row) => filter === 'all' || (filter === 'blocked' ? actionLabel(row) === 'BLOCKED' : ['requested', 'claimed', 'running', 'needs_reconciliation'].includes(row.status)));
  return <Panel title="Durable action ledger" id="ledger" detail={<label className="inline-select"><span className="sr-only">Filter actions</span><select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">All actions</option><option value="active">In progress</option><option value="blocked">Blocked</option></select></label>}>
    <div className="ledger-lifecycle"><span>requested</span><span>→</span><span>claimed</span><span>→</span><span>running</span><span>→</span><span>terminal status</span></div>
    {!filtered.length ? <Empty title={actions.length ? 'No actions match this filter' : 'No commands submitted'}>{actions.length ? 'Choose All actions to see the full ledger.' : 'Accepted commands and safety rejections appear here, identified by a stable command key.'}</Empty> : <div className="table-scroll" tabIndex={0} aria-label="Action ledger table"><table><thead><tr><th scope="col">Command key / operation</th><th scope="col">Status</th><th scope="col">Sim time</th><th scope="col">Result</th></tr></thead><tbody>{filtered.map((action) => {
      const blocked = actionLabel(action) === 'BLOCKED';
      const violations = Array.isArray(action.result.violations) ? action.result.violations.filter((v): v is string => typeof v === 'string') : [];
      return <tr key={action.command_key}><td><code>{action.command_key}</code><small>Operation not supplied by current client</small><small>Attempt {action.attempt} · v{action.version}</small></td><td><Badge tone={blocked || action.status === 'failed' ? 'danger' : action.status === 'succeeded' ? 'agent' : 'neutral'}>{blocked && <ShieldAlert size={11}/>} {actionLabel(action)}</Badge></td><td className="numeric">{duration(action.updated_sim_time_ms)}</td><td>{violations.map((code) => <details className="reason" key={code}><summary>{reasonText(code)}</summary><code>{code}</code></details>)}{!violations.length && (action.reason_code ? reasonText(action.reason_code) : '—')}</td></tr>;
    })}</tbody></table></div>}
  </Panel>;
}
