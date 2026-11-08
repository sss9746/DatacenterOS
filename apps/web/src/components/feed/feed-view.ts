// Pure helpers for the agent activity feed: actor classes, the actor filter and the newest-first cap.
// Attribution is read from the persisted `actor` field only; an event without one is neutral, never Nemotron.

import type { AgentActor, AgentEventInput } from '@dcos/db-client';

export type FeedFilter = 'all' | 'nemotron' | 'code';
export const FEED_FILTERS: readonly FeedFilter[] = ['all', 'nemotron', 'code'];
/** Newest events shown before "Show all". */
export const FEED_CAP = 6;

/** CSS modifier for an event or tool call: `actor-nemotron`, `actor-code`, or `actor-unknown` when not recorded. */
export const actorClass = (actor: AgentActor | null | undefined): 'actor-nemotron' | 'actor-code' | 'actor-unknown' =>
  actor === 'nemotron' ? 'actor-nemotron' : actor === 'code' ? 'actor-code' : 'actor-unknown';

export interface FeedSlice {
  /** Newest first, filtered, capped unless `showAll`. */
  visible: AgentEventInput[];
  /** Events matching the filter (before the cap). */
  matching: number;
  /** Events hidden by the actor filter (never by the cap). */
  filteredOut: number;
  /** Events matching the filter but hidden by the cap. */
  capped: number;
}

export function sliceFeed(events: readonly AgentEventInput[], filter: FeedFilter, showAll: boolean, cap = FEED_CAP): FeedSlice {
  const newestFirst = [...events].reverse();
  const matchingList = filter === 'all' ? newestFirst : newestFirst.filter((e) => e.actor === filter);
  const visible = showAll ? matchingList : matchingList.slice(0, cap);
  return { visible, matching: matchingList.length, filteredOut: events.length - matchingList.length, capped: matchingList.length - visible.length };
}
