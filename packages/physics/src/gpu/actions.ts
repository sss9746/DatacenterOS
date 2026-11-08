// Commands inside step() (P1-5). Placeholder hook until P1-5 lands: no command runs yet.
import type { PhysicsWorld } from '@dcos/contracts';
import type { TickCtx } from './jobs.js';
import type { HiddenState, Topology } from './world.js';

export function processCommands(
  _world: PhysicsWorld, _h: HiddenState, _topo: Topology, _ctx: TickCtx, _requestedActionIds: string[],
): void {}
