import type { IncidentLink } from '@dcos/contracts';
import { describe, expect, it } from 'vitest';
import { claimsImmediately, incidentZone, orderByZone, rackZones, racksOfGpus, resourceZone, zonesOfRacks } from '../src/zones.js';
import { loadPumpDegradedSnapshot, RUN_ID } from './fixtures/index.js';

const link = (incident: string, resource: string): IncidentLink => ({ schema_version: '1.1.0', run_id: RUN_ID, incident_id: incident, link_kind: 'resource', linked_id: resource, reason: 'test' });

describe('zones (derived from observed cooling topology)', () => {
  const snap = loadPumpDegradedSnapshot();

  it('maps racks to their cooling loop from cooling_loop.config.cools_racks', () => {
    const z = rackZones(snap);
    expect(z.get('rack-r2')).toBe('loop-a');
    expect(z.get('rack-r4')).toBe('loop-a');
    expect(z.get('rack-r7')).toBe('loop-b');
    expect(z.get('rack-r1')).toBe('loop-b');
  });

  it('resolves pumps, loops, racks, nodes and GPUs; unknown ids are null', () => {
    expect(resourceZone(snap, 'pump-a')).toBe('loop-a');
    expect(resourceZone(snap, 'loop-b')).toBe('loop-b');
    expect(resourceZone(snap, 'rack-r3')).toBe('loop-a');
    expect(resourceZone(snap, 'node-r7-n1')).toBe('loop-b');
    expect(resourceZone(snap, 'gpu-r2-n1-5')).toBe('loop-a');
    expect(resourceZone(snap, 'gpu-r8-n1-0')).toBe('loop-b');
    expect(resourceZone(snap, 'power-main')).toBeNull();
    expect(resourceZone(snap, 'nope')).toBeNull();
  });

  it('incident zone is the majority zone of its linked resources; none -> null', () => {
    const links = [link('inc-pump', 'pump-a'), link('inc-pump', 'rack-r2'), link('inc-pump', 'gpu-r7-n1-0'), link('inc-xid', 'gpu-r7-n1-3'), link('inc-xid', 'node-r7-n1')];
    expect(incidentZone('inc-pump', links, snap)).toBe('loop-a');
    expect(incidentZone('inc-xid', links, snap)).toBe('loop-b');
    expect(incidentZone('inc-none', links, snap)).toBeNull();
  });

  it('orders fresh incidents own zone -> unknown -> other, ties by id; no agent zone keeps id order', () => {
    const incs = [{ incident_id: 'inc-c-other' }, { incident_id: 'inc-b-unknown' }, { incident_id: 'inc-a-mine' }, { incident_id: 'inc-d-mine' }];
    const zoneOf = (id: string) => (id.endsWith('mine') ? 'loop-a' : id.endsWith('other') ? 'loop-b' : null);
    expect(orderByZone(incs, 'loop-a', zoneOf).map((i) => i.incident_id)).toEqual(['inc-a-mine', 'inc-d-mine', 'inc-b-unknown', 'inc-c-other']);
    expect(orderByZone(incs, null, zoneOf).map((i) => i.incident_id)).toEqual(['inc-a-mine', 'inc-b-unknown', 'inc-c-other', 'inc-d-mine']);
  });

  it('claimsImmediately: own zone, unknown zone or no configured zone', () => {
    expect(claimsImmediately(null, 'loop-b')).toBe(true);
    expect(claimsImmediately('loop-a', null)).toBe(true);
    expect(claimsImmediately('loop-a', 'loop-a')).toBe(true);
    expect(claimsImmediately('loop-a', 'loop-b')).toBe(false);
  });

  it('racksOfGpus / zonesOfRacks', () => {
    expect(racksOfGpus(snap, ['gpu-r7-n1-0', 'gpu-r8-n1-2', 'gpu-r7-n1-5', 'ghost'])).toEqual(['rack-r7', 'rack-r8']);
    expect(zonesOfRacks(snap, ['rack-r7', 'rack-r2', 'rack-r9'])).toEqual(['loop-a', 'loop-b']);
  });
});
