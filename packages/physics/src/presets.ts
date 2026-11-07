// STUB (S-1). Owned by S-3: LANE-S §5.4 S-3 step 4.
import type { FacilityConfig } from './types.js';

export type PresetKey = 'enterprise_2pump' | 'ai_hall_3pump' | 'edge_small';

export const PRESET_CONFIGS: Record<PresetKey, FacilityConfig> = {} as Record<PresetKey, FacilityConfig>;
