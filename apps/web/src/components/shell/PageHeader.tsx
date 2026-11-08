import type { ReactNode } from 'react';
import type { ROUTES } from '../../app/routes';

type Route = (typeof ROUTES)[number];

/** Compact page header: the page's name and the one question it answers. `aside` holds optional page-level badges. */
export function PageHeader({ route, aside }: { route: Route; aside?: ReactNode }) {
  return <div className="page-header"><div><h1>{route.label}</h1><p>{route.question}</p></div>{aside && <div className="page-header-aside">{aside}</div>}</div>;
}
