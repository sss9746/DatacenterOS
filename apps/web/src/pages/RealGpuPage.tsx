import type { PageProps } from '../app/page-props';
import { RealGpu } from '../components/heatmap/RealGpu';

/** Page 6 — "What is the one real L40S doing?" Owner: agent D. Keeps RealGpu.tsx's live/REPLAY/offline logic intact. */
export function RealGpuPage({ state, now }: PageProps) {
  return <RealGpu evidence={state.evidence} now={now}/>;
}
