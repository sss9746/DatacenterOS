import { CircleHelp, Grid2X2, ListChecks, Radio, BarChart3, GitBranch, Cpu } from 'lucide-react';
import { ROUTES, hrefOf, type RouteId } from '../../app/routes';

const ICONS: Record<RouteId, typeof Grid2X2> = { cluster: Grid2X2, jobs: ListChecks, recovery: Radio, workflows: GitBranch, benchmarks: BarChart3, 'real-gpu': Cpu };
/** Short labels for the icon rail (≤1200) and the phone tab row (≤680); the full label stays in the tooltip. */
const SHORT: Record<RouteId, string> = { cluster: 'Cluster', jobs: 'Jobs', recovery: 'Recovery', workflows: 'Workflows', benchmarks: 'Benchmarks', 'real-gpu': 'Real GPU' };

/** Left navigation: one link per page. 190px rail ≥1200, 64px icon rail ≤1200, horizontal tab row ≤680. */
export function Sidebar({ route }: { route: RouteId }) {
  return <aside className="sidebar">
    <nav aria-label="Dashboard pages">
      {ROUTES.map((row) => {
        const Icon = ICONS[row.id];
        const active = route === row.id;
        return <a key={row.id} href={hrefOf(row.id)} title={row.label} aria-current={active ? 'page' : undefined} className={active ? 'is-active' : undefined}>
          <Icon aria-hidden="true"/><span className="nav-label">{row.label}</span><span className="nav-label-short" aria-hidden="true">{SHORT[row.id]}</span>
        </a>;
      })}
    </nav>
    <div className="sidebar-note"><CircleHelp size={17} aria-hidden="true"/><p>A digital twin.<br/>Every modeled value is labeled simulated.</p><span>HackUTD 2026</span></div>
  </aside>;
}
