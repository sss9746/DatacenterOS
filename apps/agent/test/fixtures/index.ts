// Typed access to the committed P3 fixtures (gpu_demo_8). Always returns a fresh deep copy.
import type { ObservedSnapshot, SignalEvent } from '@dcos/contracts';
import demo from './observed_snapshot_demo.json' with { type: 'json' };
import pumpDegraded from './observed_snapshot_pump_degraded.json' with { type: 'json' };
import xid79R7 from './signal_xid79_r7.json' with { type: 'json' };
import xid79Dest from './signal_xid79_dest.json' with { type: 'json' };

import type { FixtureName } from './gpu-demo-8.js';

export * from './gpu-demo-8.js';

export const FIXTURE_TYPES = {
  observed_snapshot_demo: 'ObservedSnapshot',
  observed_snapshot_pump_degraded: 'ObservedSnapshot',
  signal_xid79_r7: 'SignalEvent',
  signal_xid79_dest: 'SignalEvent',
} as const;

const copy = <T>(v: unknown): T => structuredClone(v) as T;

export const RAW_FIXTURES: Record<FixtureName, unknown> = {
  observed_snapshot_demo: demo,
  observed_snapshot_pump_degraded: pumpDegraded,
  signal_xid79_r7: xid79R7,
  signal_xid79_dest: xid79Dest,
};

export const loadDemoSnapshot = () => copy<ObservedSnapshot>(demo);
export const loadPumpDegradedSnapshot = () => copy<ObservedSnapshot>(pumpDegraded);
export const loadSignalXid79R7 = () => copy<SignalEvent>(xid79R7);
export const loadSignalXid79Dest = () => copy<SignalEvent>(xid79Dest);
