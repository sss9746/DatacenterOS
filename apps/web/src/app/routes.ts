/**
 * Hash routes for the multi-page dashboard. No router dependency: `#/cluster`, `#/jobs`, … are read from
 * `window.location.hash`, so deep links and the browser back button work. Legacy single-page anchors
 * (`#overview`, `#jobs`, `#activity`, `#scoreboard`, `#ledger`, `#workflows`) redirect to their page; the retired
 * `#/real-gpu` page redirects to the cluster overview, which now hosts the real GPU tile.
 */
export const ROUTES = [
  { id: 'cluster', label: 'Cluster overview', question: 'Is the cluster healthy right now?' },
  { id: 'jobs', label: 'Training jobs', question: 'Is any training work at risk?' },
  { id: 'recovery', label: 'Recovery activity', question: 'What did the agents see, decide and do?' },
  { id: 'workflows', label: 'Workflows', question: 'Where is each recovery, and what was blocked?' },
  { id: 'benchmarks', label: 'Benchmarks', question: 'Did the Nemotron planner lose less work than the baselines?' },
] as const;

export type RouteId = (typeof ROUTES)[number]['id'];
export const DEFAULT_ROUTE: RouteId = 'cluster';

export const isRouteId = (value: string): value is RouteId => ROUTES.some((route) => route.id === value);
export const hrefOf = (id: RouteId): string => `#/${id}`;

/** Old in-page anchors that moved to a page of their own. */
const LEGACY_ANCHORS: Record<string, RouteId> = {
  overview: 'cluster', topology: 'cluster', jobs: 'jobs', activity: 'recovery', incidents: 'recovery', 'agent-room': 'recovery',
  workflows: 'workflows', ledger: 'workflows', model: 'workflows', 'model-assumptions': 'workflows', signals: 'workflows', details: 'workflows',
  scoreboard: 'benchmarks', 'real-gpu': 'cluster', presenter: 'cluster',
};

/** `#/jobs`, `#/jobs/anchor`, `#jobs` and `` all resolve to a page id; unknown hashes fall back to the default route. */
export function routeFromHash(hash: string): RouteId {
  const raw = hash.replace(/^#\/?/, '');
  const head = raw.split(/[/?]/)[0] ?? '';
  if (isRouteId(head)) return head;
  return LEGACY_ANCHORS[head] ?? DEFAULT_ROUTE;
}

/** Optional in-page anchor after the route: `#/workflows/ledger` → `ledger`. */
export function anchorFromHash(hash: string): string | null {
  const raw = hash.replace(/^#\/?/, '');
  const [head, anchor] = raw.split('/');
  return head && isRouteId(head) && anchor ? anchor : null;
}
