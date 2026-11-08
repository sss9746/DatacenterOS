import type { GpuCurrent, ObservedSnapshot } from '@dcos/contracts';
import { STEP_MS } from '@dcos/physics';
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

/**
 * How far (sim-ms) a reachable GPU's readings lag behind the freshest reachable GPU in the same snapshot. Positive
 * beyond one tick means its sensors are stale (physics `sensor_stale` freezes `last_seen_sim_ms`). Compared to peers,
 * not to the clock, so a snapshot whose producer never updates last_seen flags nothing. Unreachable GPUs are never
 * "stale": their readings froze because they fell off the bus.
 */
export function staleReadingMs(gpu: Pick<GpuCurrent, 'resource_id' | 'availability' | 'last_seen_sim_ms'>, gpus: readonly Pick<GpuCurrent, 'resource_id' | 'availability' | 'last_seen_sim_ms'>[]): number {
  if (gpu.availability === 'unreachable') return 0;
  const freshest = Math.max(...gpus.filter((row) => row.availability !== 'unreachable' && row.resource_id !== 'gpu-real-0').map((row) => row.last_seen_sim_ms));
  if (!Number.isFinite(freshest)) return 0;
  const lag = freshest - gpu.last_seen_sim_ms;
  return lag > STEP_MS ? lag : 0;
}

/** Plain-English state of a GPU that is not ready, from its observed availability and last Xid code only. */
export function gpuFaultText(gpu: Pick<GpuCurrent, 'availability' | 'last_xid_code'>): string {
  if (gpu.availability === 'unreachable') return 'Unavailable';
  if (gpu.availability === 'cordoned') return 'Cordoned';
  if (gpu.availability === 'degraded') return gpu.last_xid_code !== null ? `Degraded · Xid ${gpu.last_xid_code}` : 'Degraded';
  return gpu.last_xid_code !== null ? `Xid ${gpu.last_xid_code}` : 'Running normally';
}
