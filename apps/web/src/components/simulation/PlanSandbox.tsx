import { useState } from 'react';
import { FlaskConical, RefreshCw } from 'lucide-react';
import type { ActionCommand, ObservedSnapshot } from '@dcos/contracts';
import { evaluateSafety, simulatePlan, type PlanMetrics } from '@dcos/physics';
import { Button } from '../ui/button';
import { reasonText } from '../ledger/Ledger';
import './plan-sandbox.css';

type Option = { label: string; metrics: PlanMetrics | null; safety: string; explanation: string };
type Comparison = { epoch: number; at: number; jobId: string; options: Option[] };

function command(obs: ObservedSnapshot, jobId: string, key: string, operation: ActionCommand['operation'], args: Record<string, unknown> = {}, dependencies: string[] = []): ActionCommand {
  return {
    schema_version: '1.1.0', run_id: obs.run_id, action_id: `preview.${key}`, command_key: `preview.${key}`,
    workflow_id: 'preview.workflow', plan_id: 'preview.plan', incident_ids: ['preview.incident'],
    operation, target_resource_id: jobId, job_id: jobId, arguments: args,
    depends_on_command_keys: dependencies, expected_decision_epoch: obs.clock.decision_epoch,
    expected_resource_versions: {}, requested_sim_time_ms: obs.clock.sim_time_ms,
  };
}

export function PlanSandbox({ snapshot }: { snapshot: ObservedSnapshot }) {
  const [jobId, setJobId] = useState('job-a');
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const job = snapshot.job_states.find((row) => row.job_id === jobId);

  function compare() {
    if (!job) return;
    setError(null);
    try {
      const horizon_s = 180;
      const run = (commands: ActionCommand[]) => simulatePlan(snapshot, { commands }, { horizon_s, seed: 42 });
      const safety = (commands: ActionCommand[]) => {
        const reasons = commands.flatMap((cmd) => evaluateSafety(snapshot, cmd, { decision_epoch: snapshot.clock.decision_epoch, leased_resource_ids: [] }).violations);
        return reasons.length ? [...new Set(reasons)].map(reasonText).join('; ') : 'No current safety denial';
      };
      const cap = command(snapshot, jobId, `${jobId}.cap`, 'power_cap', { power_limit_w: 500 });
      const spec = snapshot.job_specs.find((row) => row.job_id === jobId);
      const occupied = new Set(snapshot.allocations.map((row) => row.gpu_id));
      const free = snapshot.gpus.filter((gpu) => gpu.availability === 'ready' && !occupied.has(gpu.resource_id) && gpu.resource_id !== 'gpu-real-0');
      const destination = free.slice(0, spec?.gpus_required ?? 0).map((gpu) => gpu.resource_id);
      const canMove = Boolean(spec && destination.length === spec.gpus_required);
      const checkpoint = command(snapshot, jobId, `${jobId}.checkpoint`, 'checkpoint');
      const move = command(snapshot, jobId, `${jobId}.move`, 'migrate_restart', { destination_gpu_ids: destination }, job.status === 'failed' ? [] : [checkpoint.command_key]);
      const moveCommands = job.status === 'failed' ? [move] : [checkpoint, move];
      setComparison({ epoch: snapshot.clock.decision_epoch, at: snapshot.clock.sim_time_ms, jobId, options: [
        { label: 'Keep running', metrics: run([]), safety: 'No action requested', explanation: 'Reference path with the observed conditions continuing.' },
        { label: 'Cap power', metrics: run([cap]), safety: safety([cap]), explanation: 'Reduce power on the job’s current GPUs.' },
        { label: job.status === 'failed' ? 'Restart elsewhere' : 'Checkpoint and move', metrics: canMove ? run(moveCommands) : null,
          safety: canMove ? safety(moveCommands) : 'Not enough free GPUs', explanation: canMove ? `Use ${destination.length} currently free GPUs; checkpoint first when the job is running.` : 'The current cluster lacks a complete free destination.' },
      ] });
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Plan comparison failed.'); }
  }

  const stale = comparison && comparison.epoch !== snapshot.clock.decision_epoch;
  return <section className="plan-sandbox" aria-labelledby="plan-sandbox-title"><div className="plan-sandbox-head"><div><h2 id="plan-sandbox-title"><FlaskConical size={17} aria-hidden="true"/> Test a response in a copy</h2><p>Compare three choices for one job using current observed data. The live local run does not change.</p></div><div className="plan-sandbox-controls"><label>Training job<select value={jobId} onChange={(event) => setJobId(event.target.value)}>{snapshot.job_states.map((row) => <option value={row.job_id} key={row.job_id}>{row.job_id}</option>)}</select></label><Button variant="secondary" onClick={compare}><RefreshCw size={14}/>Compare plans</Button></div></div>
    {error && <p role="alert" className="error-message">{error}</p>}
    {comparison && <><div className="plan-sandbox-meta"><span>{comparison.jobId} · estimated 180 sim seconds from {Math.round(comparison.at / 1000)} s</span>{stale && <strong>World changed. Compare again for current estimates.</strong>}</div><div className="plan-options">{comparison.options.map((option) => <article className="plan-option" key={option.label}><h3>{option.label}</h3><p>{option.explanation}</p>{option.metrics ? <dl><div><dt>Projected lost work</dt><dd>{Math.round(option.metrics.expected_lost_work_units).toLocaleString()} units</dd></div><div><dt>Completion delay</dt><dd>{Math.round(option.metrics.expected_completion_delay_sim_s)} s</dd></div><div><dt>GPU time wasted</dt><dd>{Math.round(option.metrics.expected_gpu_busy_waste_s)} s</dd></div><div><dt>Estimated risk</dt><dd>{Math.round(option.metrics.failure_risk_estimate * 100)}%</dd></div></dl> : <p className="plan-unavailable">No valid destination available</p>}<div className={`plan-safety ${option.safety === 'No current safety denial' || option.safety === 'No action requested' ? '' : 'plan-safety-warning'}`}>{option.safety}</div></article>)}</div></>}
    {!comparison && <p className="plan-sandbox-empty">Choose a job and compare plans to see estimates from a separate copy of the observed world.</p>}
    <p className="plan-sandbox-note">Predictions assume current observed degradation persists and no new hidden fault occurs. They are local estimates, not an agent decision or executed recovery.</p>
  </section>;
}
