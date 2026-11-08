// publish_evaluation_result(result_json): admin (CONTRACTS §0.9). One EvaluationResult row per
// (scenario_id, policy, seed); re-publishing replaces it. Evaluation runs are offline harness runs,
// so `run_id` is the scenario's run id, not necessarily the live run.
//
// EvaluationResult has no version fields (provenance is an open integrator item); the row records
// the physics model version this module bundles and leaves policy_version empty.
import { t } from 'spacetimedb/server';
import { validatePayload, type EvaluationResult } from '@dcos/contracts';
import { GPU_MODEL_VERSION } from '@dcos/physics';
import spacetimedb from './schema';
import { reject, requireRole } from './auth';

export const publish_evaluation_result = spacetimedb.reducer({ result_json: t.string() }, (ctx, { result_json }) => {
  requireRole(ctx, 'admin');
  let raw: unknown;
  try {
    raw = JSON.parse(result_json);
  } catch {
    reject('INVALID_PAYLOAD', 'result_json is not valid JSON');
  }
  const v = validatePayload('EvaluationResult', raw);
  if (!v.ok) reject('INVALID_PAYLOAD', `EvaluationResult: ${v.errors.slice(0, 5).join('; ')}`);
  const { schema_version: _v, run_id, scenario_id, seed, policy, ...metrics } = raw as EvaluationResult;

  const row = {
    result_id: `${scenario_id}/${policy}/${seed}`,
    run_id,
    scenario_id,
    policy,
    seed,
    metrics_json: JSON.stringify(metrics),
    policy_version: '',
    physics_profile_version: GPU_MODEL_VERSION,
  };
  if (ctx.db.evaluation_result.result_id.find(row.result_id)) ctx.db.evaluation_result.result_id.update(row);
  else ctx.db.evaluation_result.insert(row);
});
