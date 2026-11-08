import type { ReactNode } from 'react';
import { Boxes, ExternalLink } from 'lucide-react';
import { Badge } from '../ui/panel';

/** Forest masthead (§4): display-face brand, honesty mode badge, optional controls slot (the run-view select in mock mode). No sidebar. */
export function Header({ mode, localPhysics = false, dbName, children }: { mode: 'mock' | 'live'; localPhysics?: boolean; dbName?: string; children?: ReactNode }) {
  const label = localPhysics ? 'Mock · local physics' : mode === 'mock' ? 'Mock · fixtures' : `Live DB · ${dbName ?? 'unknown'}`;
  return <header className="masthead">
    <a className="brand" href="#overview" aria-label="DataCenterOS overview"><span className="brand-mark"><Boxes size={18} strokeWidth={1.8} aria-hidden="true"/></span><span>DataCenter<span className="brand-os">OS</span></span></a>
    <div className="masthead-meta">
      <span className="masthead-tagline desktop-only">GPU cluster digital twin</span>
      <Badge tone={mode === 'mock' ? 'mock' : 'real'}>{label}</Badge>
      {children}
      <a className="icon-link" href="https://github.com/sss9746/DatacenterOS" target="_blank" rel="noreferrer" aria-label="Open DataCenterOS repository"><ExternalLink size={17}/></a>
    </div>
  </header>;
}
