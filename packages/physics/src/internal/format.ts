// Number formatting shared by safety reason strings (LANE-S §3.2).
export const fmt = (x: number): string => String(Math.round(x * 10) / 10);
