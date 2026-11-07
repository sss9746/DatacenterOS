// Internal physics constants (LANE-S §3). Not part of the public contract.
export const CTRL_TAU_S = 30;          // satisfied racks recover toward ambient with this time constant
export const PUMP_DRAW_FRAC = 0.05;    // an online pump draws 5% of its cooling capacity as electrical power
export const T_MIN_C = 18;
export const T_MAX_C = 90;
export const T_RECOVER_C = 40;         // degraded → online below this
export const SENSOR_STALE_S = 15;      // monitors: sensor_age_s above this = stale
export const DEFAULT_SPIKE_KW = 4;     // load_spike default extra_kw
