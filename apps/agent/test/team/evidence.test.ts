import { describe, expect, it } from 'vitest';
import { packWorkloadEvidence } from '../../src/team/roles.js';
import { indexSnapshot } from '../../src/tools/index.js';
import { loadPumpDegradedSnapshot } from '../fixtures/index.js';

describe('workload evidence', () => {
  it('tells Workload which racks each running job is on, so it can answer Cooling', () => {
    const bundle = packWorkloadEvidence(indexSnapshot(loadPumpDegradedSnapshot()), [], null, ['job-a']);
    const jobs = (JSON.parse(bundle.json) as { jobs: { job_id: string; current_rack_ids: string[] }[] }).jobs;
    const racksOf = (id: string) => jobs.find((j) => j.job_id === id)?.current_rack_ids;

    expect(racksOf('job-a')).toEqual(['rack-r2', 'rack-r3']);
    expect(racksOf('job-c')).toEqual(['rack-r6']);
    expect(bundle.resource_ids.has('rack-r6')).toBe(true);
  });
});
