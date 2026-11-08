import { describe, expect, it } from 'vitest';
import { DEFAULT_ROUTE, ROUTES, anchorFromHash, hrefOf, isRouteId, routeFromHash } from '../src/app/routes';

describe('hash routes', () => {
  it('lists five pages, each with a label and the question it answers', () => {
    expect(ROUTES.map((row) => row.id)).toEqual(['cluster', 'jobs', 'recovery', 'workflows', 'benchmarks']);
    for (const row of ROUTES) { expect(row.label.length).toBeGreaterThan(0); expect(row.question).toMatch(/\?$/); }
  });

  it('builds canonical hrefs and recognises route ids', () => {
    expect(hrefOf('jobs')).toBe('#/jobs');
    expect(hrefOf('benchmarks')).toBe('#/benchmarks');
    expect(isRouteId('benchmarks')).toBe(true);
    expect(isRouteId('ledger')).toBe(false);
  });

  it('resolves canonical hashes, with or without an anchor or query', () => {
    expect(routeFromHash('#/workflows')).toBe('workflows');
    expect(routeFromHash('#/workflows/ledger')).toBe('workflows');
    expect(routeFromHash('#/benchmarks?x=1')).toBe('benchmarks');
    expect(routeFromHash('#/real-gpu')).toBe('cluster'); // retired page: its deep link lands on the cluster overview
  });

  it('maps legacy single-page anchors to the page that now owns them', () => {
    const legacy: Record<string, string> = {
      overview: 'cluster', topology: 'cluster', presenter: 'cluster', jobs: 'jobs', activity: 'recovery', incidents: 'recovery', 'agent-room': 'recovery',
      workflows: 'workflows', ledger: 'workflows', model: 'workflows', 'model-assumptions': 'workflows', signals: 'workflows', details: 'workflows',
      scoreboard: 'benchmarks', 'real-gpu': 'cluster',
    };
    for (const [anchor, route] of Object.entries(legacy)) expect(routeFromHash(`#${anchor}`), anchor).toBe(route);
  });

  it('falls back to the default route for empty or unknown hashes', () => {
    expect(routeFromHash('')).toBe(DEFAULT_ROUTE);
    expect(routeFromHash('#')).toBe(DEFAULT_ROUTE);
    expect(routeFromHash('#/nowhere')).toBe(DEFAULT_ROUTE);
    expect(routeFromHash('#nowhere')).toBe(DEFAULT_ROUTE);
  });

  it('extracts an in-page anchor only after a canonical route', () => {
    expect(anchorFromHash('#/workflows/ledger')).toBe('ledger');
    expect(anchorFromHash('#/workflows')).toBeNull();
    expect(anchorFromHash('#ledger')).toBeNull();
    expect(anchorFromHash('#/nowhere/ledger')).toBeNull();
    expect(anchorFromHash('')).toBeNull();
  });
});
