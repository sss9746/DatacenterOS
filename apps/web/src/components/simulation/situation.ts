import type { ObservedSnapshot } from '@dcos/contracts';
import { coolingLoops, degradedPumps, pumpLabel, rackRanges } from './topology';

/** Thermal-throttle bit in `clocks_event_reasons` (nvidia-smi convention). */
const THROTTLE_BIT = 0x20;

/**
 * One plain-English sentence about the simulated cluster, derived only from the observed snapshot: pumps first,
 * then failures and what is happening to their jobs, then heat. The real GPU (`gpu-real-0`) is not part of it.
 */
export function situation(snapshot: ObservedSnapshot): string {
  const gpus = snapshot.gpus.filter((gpu) => gpu.resource_id !== 'gpu-real-0');
  const failed = gpus.filter((gpu) => gpu.availability !== 'ready' || gpu.last_xid_code !== null).length;
  const throttled = gpus.filter((gpu) => (gpu.clocks_event_reasons & THROTTLE_BIT) !== 0 || gpu.temp_c >= 85).length;
  const warm = gpus.filter((gpu) => gpu.temp_c >= 80).length;
  const moving = snapshot.job_states.filter((job) => job.status === 'restarting').length;
  const stopped = snapshot.job_states.filter((job) => job.status === 'failed' || job.status === 'paused').length;
  const loops = coolingLoops(snapshot);
  const degraded = degradedPumps(snapshot);
  const parts: string[] = [];
  for (const pump of degraded) {
    const racks = loops.find((loop) => loop.pumpId === pump.resource_id)?.racks ?? [];
    parts.push(`${pumpLabel(pump.resource_id)} is failing${racks.length ? ` — ${rackRanges(racks)} ${warm ? 'heating' : 'losing cooling'}` : ''}`);
  }
  if (failed) parts.push(`${failed} GPU${failed === 1 ? '' : 's'} failed${moving ? ` — ${moving === 1 ? 'its job is' : `${moving} jobs are`} being moved` : stopped ? ` — ${stopped} job${stopped === 1 ? '' : 's'} stopped` : ''}`);
  if (!degraded.length && throttled) parts.push(`${throttled} GPU${throttled === 1 ? '' : 's'} slowing down from heat`);
  if (parts.length === 0) return `All ${gpus.length} GPUs healthy`;
  return parts.join('. ');
}

/** `warning` when cooling or heat is the story, `danger` once a GPU has failed, otherwise `normal`. */
export function situationTone(snapshot: ObservedSnapshot): 'normal' | 'warning' | 'danger' {
  const gpus = snapshot.gpus.filter((gpu) => gpu.resource_id !== 'gpu-real-0');
  if (gpus.some((gpu) => gpu.availability !== 'ready' || gpu.last_xid_code !== null)) return 'danger';
  if (degradedPumps(snapshot).length || gpus.some((gpu) => gpu.temp_c >= 85 || (gpu.clocks_event_reasons & THROTTLE_BIT) !== 0)) return 'warning';
  return 'normal';
}
