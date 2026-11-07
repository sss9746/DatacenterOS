// Builder presets (LANE-S §5.4 S-3 step 4). Owned by S-3.
import { defaultDemoConfig } from './compile.js';
import type { FacilityConfig } from './types.js';

export type PresetKey = 'enterprise_2pump' | 'ai_hall_3pump' | 'edge_small';

export const PRESET_CONFIGS: Record<PresetKey, FacilityConfig> = {
  enterprise_2pump: { ...defaultDemoConfig(), name: 'Enterprise DC-1' },
  ai_hall_3pump: {
    name: 'AI Hall B',
    template: 'ai_compute',
    seed: 42,
    components: {
      utility: { count: 1, capacity_kw: 200 },
      ups: { count: 1, energy_kwh: 20, max_output_kw: 120 },
      pump: { count: 3, capacity_kw: 30 },
      rack: { count: 8, load_kw: 6, real_fan_rack: 3 },
    },
    redundancy: { cooling: 'N+1' },
  },
  edge_small: {
    name: 'Edge Site',
    template: 'edge',
    seed: 42,
    components: {
      utility: { count: 1, capacity_kw: 60 },
      ups: { count: 1, energy_kwh: 5, max_output_kw: 40 },
      pump: { count: 1, capacity_kw: 30 },
      rack: { count: 4, load_kw: 5, real_fan_rack: 3 },
    },
    redundancy: { cooling: 'N' },
  },
};
