import { Boxes, CircleHelp, ExternalLink, Grid2X2, ListChecks, Radio, BarChart3 } from 'lucide-react';
import { Badge } from '../ui/panel';
export function Header({ mode, localPhysics = false }: { mode: 'mock' | 'live'; localPhysics?: boolean }) {
  return <>
    <header className="masthead"><a className="brand" href="#overview" aria-label="DataCenterOS overview"><Boxes size={25} strokeWidth={1.7} /><span>DataCenter<span className="brand-os">OS</span></span></a><div className="masthead-meta"><span className="desktop-only">GPU cluster reliability</span><Badge tone={mode === 'mock' ? 'warning' : 'neutral'}>{localPhysics ? 'Local physics' : mode === 'mock' ? 'Mock fixtures' : 'Live mode'}</Badge><a className="icon-link" href="https://github.com/sss9746/DatacenterOS" target="_blank" rel="noreferrer" aria-label="Open DataCenterOS repository"><ExternalLink size={17}/></a></div></header>
    <aside className="sidebar"><nav aria-label="Dashboard sections"><a href="#overview"><Grid2X2/>Cluster overview</a><a href="#jobs"><ListChecks/>Training jobs</a><a href="#activity"><Radio/>Recovery activity</a><a href="#scoreboard"><BarChart3/>Benchmarks</a></nav><div className="sidebar-note"><CircleHelp size={17}/><p>A digital twin.<br/>Every modeled value is labeled simulated.</p><span>HackUTD 2026</span></div></aside>
  </>;
}
