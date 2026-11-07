// Deterministic builder layout (LANE-S §5.4 S-3 step 1). Owned by S-3.
// Columns: utility x=0, ups x=220, pumps x=440, racks x=700+170×col (4 per row). Rows are 130 apart.

export const LAYOUT_X_UTILITY = 0;
export const LAYOUT_X_UPS = 220;
export const LAYOUT_X_PUMP = 440;
export const LAYOUT_X_RACK0 = 700;
export const LAYOUT_RACK_DX = 170;
export const LAYOUT_DY = 130;
export const LAYOUT_RACKS_PER_ROW = 4;

export type LayoutKind = 'utility' | 'ups' | 'pump' | 'rack';

/** Position of the `index`-th (0-based) component of a kind. */
export function layoutPosition(kind: LayoutKind, index: number): { x: number; y: number } {
  if (kind === 'rack') {
    const col = index % LAYOUT_RACKS_PER_ROW;
    const row = Math.floor(index / LAYOUT_RACKS_PER_ROW);
    return { x: LAYOUT_X_RACK0 + LAYOUT_RACK_DX * col, y: LAYOUT_DY * row };
  }
  const x = kind === 'utility' ? LAYOUT_X_UTILITY : kind === 'ups' ? LAYOUT_X_UPS : LAYOUT_X_PUMP;
  return { x, y: LAYOUT_DY * index };
}
