/** Which presenter surface is showing: browser-local physics, the fixture mock, the live shared run, or read-only. */
export type ControlsMode = 'local' | 'fixture' | 'live' | 'readonly';

export function controlsMode(clientMode: 'mock' | 'live', localPhysics: boolean, canAdmin: boolean): ControlsMode {
  if (!canAdmin) return 'readonly';
  if (clientMode === 'live') return 'live';
  return localPhysics ? 'local' : 'fixture';
}

export const MODE_BADGE: Record<ControlsMode, string> = {
  local: 'Local preview · mock',
  fixture: 'Mock fixture preview',
  live: 'Live · shared run',
  readonly: 'Read-only',
};
