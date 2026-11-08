// ActionCommand.arguments by operation (CONTRACTS §0.11 #1, §0.12 #6). Shared by physics (actions.ts) and the safety
// check (safety.ts), so both accept exactly the same payloads. Pure; only `import type` from @dcos/contracts.
//
//   checkpoint {}            pause_job {}            cordon_gpu {} / uncordon_gpu {} (the GPU is target_resource_id)
//   keep_running {}          escalate { reason: string }
//   power_cap { power_limit_w: number }   (0 < W ≤ 700; omitted → the §0.4 default cap of 500 W)
//   migrate_restart { destination_gpu_ids: string[] }    the standard form, what policies and P3 send (§0.12 #6)
//                 | { destination_node_ids: string[] }   accepted for judge / manual use only: first free ready GPUs
//                                                        on those nodes. Exactly one of the two.
// Any other key, a wrong type, or both / neither migrate destination forms → INVALID_ARGUMENT (§0.12 #4).
import type { ActionCommand } from '@dcos/contracts';
import { POWER_LIMIT_W } from './constants.js';

/** The argument names each operation accepts. */
export const OPERATION_ARGUMENTS: Readonly<Record<ActionCommand['operation'], readonly string[]>> = {
  checkpoint: [],
  migrate_restart: ['destination_gpu_ids', 'destination_node_ids'],
  power_cap: ['power_limit_w'],
  pause_job: [],
  cordon_gpu: [],
  uncordon_gpu: [],
  keep_running: [],
  escalate: ['reason'],
};

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0);

/**
 * Problems with cmd.arguments for its operation, as short human-readable strings; [] = well-formed. An operation
 * outside the contract enum returns [] (that is UNSUPPORTED_OPERATION, reported elsewhere).
 */
export function argumentProblems(cmd: ActionCommand): string[] {
  const allowed = OPERATION_ARGUMENTS[cmd.operation];
  if (!allowed) return [];
  const args = cmd.arguments as unknown;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return ['arguments must be an object'];
  const a = args as Record<string, unknown>;
  const out: string[] = [];
  for (const k of Object.keys(a).sort()) if (!allowed.includes(k)) out.push(`unknown argument ${k} for ${cmd.operation}`);
  switch (cmd.operation) {
    case 'migrate_restart': {
      const gpus = 'destination_gpu_ids' in a;
      const nodes = 'destination_node_ids' in a;
      if (gpus === nodes) out.push('migrate_restart needs exactly one of destination_gpu_ids / destination_node_ids');
      if (gpus && !isStringList(a.destination_gpu_ids)) out.push('destination_gpu_ids must be a list of ids');
      if (nodes && !isStringList(a.destination_node_ids)) out.push('destination_node_ids must be a list of ids');
      break;
    }
    case 'power_cap': {
      const w = a.power_limit_w;
      if (w !== undefined && !(typeof w === 'number' && Number.isFinite(w) && w > 0 && w <= POWER_LIMIT_W)) {
        out.push(`power_limit_w must be a number in (0, ${POWER_LIMIT_W}]`);
      }
      break;
    }
    case 'escalate':
      if (typeof a.reason !== 'string' || a.reason.length === 0) out.push('escalate needs reason: string');
      break;
    default:
      break;
  }
  return out;
}
