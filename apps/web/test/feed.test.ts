import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentEventInput } from '@dcos/db-client';
import { Feed, teamMessageLabel } from '../src/components/feed/Feed';
import { FEED_CAP, actorClass, sliceFeed } from '../src/components/feed/feed-view';

let n = 0;
const ev = (patch: Partial<AgentEventInput>): AgentEventInput => ({
  agent_event_id: `e-${n++}`, run_id: 'run-1', workflow_id: 'wf-1', incident_id: null, stage: 'execute', summary: 's', evidence_ids: [], tool_calls: [], actor: 'code', sim_time_ms: 1000, observed_unix_ms: 0, ...patch,
});

describe('actor classes come from the persisted actor field', () => {
  it('maps nemotron, code and missing actors; a missing actor is never Nemotron', () => {
    expect(actorClass('nemotron')).toBe('actor-nemotron');
    expect(actorClass('code')).toBe('actor-code');
    expect(actorClass(undefined)).toBe('actor-unknown');
    expect(actorClass(null)).toBe('actor-unknown');
  });
  it('renders the class on the article and the tool call, and hides the empty evidence line', () => {
    const html = renderToStaticMarkup(createElement(Feed, { example: false, events: [
      ev({ actor: 'code', tool_calls: [{ tool: 'simulate_plan', args_summary: 'a', result_summary: 'r', actor: 'nemotron' }] }),
      ev({ actor: 'nemotron', evidence_ids: ['ev-1'] }),
      ev({ actor: undefined }),
    ] }));
    expect(html).toContain('class="feed-event actor-code"');
    expect(html).toContain('class="feed-event actor-nemotron"');
    expect(html).toContain('class="feed-event actor-unknown"');
    expect(html).toContain('class="tool-call actor-nemotron"');
    expect(html).toContain('Actor not recorded');
    expect(html).not.toContain('No evidence IDs supplied');
    expect(html).toContain('ev-1');
    expect(html).toContain('aria-pressed="true"');
  });
});

describe('feed filter and cap', () => {
  const events = [...Array(10).keys()].map((i) => ev({ actor: i % 3 === 0 ? 'nemotron' : 'code', sim_time_ms: i }));
  it('shows the newest 6 first and reports what the cap hides', () => {
    const s = sliceFeed(events, 'all', false);
    expect(s.visible).toHaveLength(FEED_CAP);
    expect(s.visible[0]!.sim_time_ms).toBe(9);
    expect(s).toMatchObject({ matching: 10, filteredOut: 0, capped: 4 });
    expect(sliceFeed(events, 'all', true).visible).toHaveLength(10);
  });
  it('filters by the real actor and keeps the filtered-out count', () => {
    const s = sliceFeed(events, 'nemotron', false);
    expect(s.visible.every((e) => e.actor === 'nemotron')).toBe(true);
    expect(s).toMatchObject({ matching: 4, filteredOut: 6, capped: 0 });
    expect(sliceFeed(events, 'code', true)).toMatchObject({ matching: 6, filteredOut: 4 });
  });
  it('does not count unlabelled events as Nemotron or Code', () => {
    const s = sliceFeed([ev({ actor: undefined }), ev({ actor: 'code' })], 'nemotron', true);
    expect(s).toMatchObject({ matching: 0, filteredOut: 2 });
  });
});

describe('agent-team messages (event log)', () => {
  it('labels team_message tool calls with the route and kind from the args, never from the actor', () => {
    expect(teamMessageLabel('question cooling->workload')).toBe('Cooling → Workload · question');
    expect(teamMessageLabel('objection supervisor->workload ev=x')).toBe('Supervisor → Workload · objection');
    expect(teamMessageLabel('outcome')).toBe('team round');
    const html = renderToStaticMarkup(createElement(Feed, { example: false, id: 'event-log', title: 'Event log', events: [
      ev({ actor: 'nemotron', summary: 'Workload → Cooling: job-c on r6', tool_calls: [{ tool: 'team_message', args_summary: 'answer workload->cooling', result_summary: 'consumed by cooling, lead', actor: 'nemotron' }, { tool: 'simulate_plan', args_summary: 'x', result_summary: 'y', actor: 'code' }] }),
      ev({ actor: 'code', tool_calls: [{ tool: 'agent_message', args_summary: 'from=a-1 to=b-2 topic=ack', result_summary: 'ok', actor: 'code' }] }),
    ] }));
    expect(html).toContain('id="event-log"');
    expect(html).toContain('tool-call actor-nemotron tool-call-message');
    expect(html).toContain('Workload → Cooling · answer');
    // The dropped `agent_message` tool gets no message styling.
    expect((html.match(/feed-agent-chip/g) ?? []).length).toBe(1);
    expect(html).not.toContain('a-1 → b-2');
  });
});
