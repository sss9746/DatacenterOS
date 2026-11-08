// Pure parser for the agent team's `team_message` tool call (apps/agent/src/team/protocol.ts `teamFeedEvents`).
// The args are written by code, never by a model: `<kind> <from>-><to>`, optionally followed by more tokens.
// The two code-only rows (`missing_roles`, `outcome`) also use the tool name but carry no route, so they parse to null.

import type { ToolCallSummary } from '@dcos/db-client';

export const TEAM_MESSAGE_TOOL = 'team_message';
export const TEAM_KINDS = ['question', 'answer', 'finding', 'objection', 'cover', 'decision'] as const;
export type TeamKind = (typeof TEAM_KINDS)[number];
export const TEAM_PARTIES = ['cooling', 'workload', 'lead', 'supervisor'] as const;
export type TeamParty = (typeof TEAM_PARTIES)[number];

export interface ParsedTeamMessage {
  kind: TeamKind;
  from: TeamParty;
  to: TeamParty;
  /** Anything after the route (e.g. `ev=…`), trimmed; null when absent. */
  extra: string | null;
}

export const PARTY_LABEL: Record<TeamParty, string> = { cooling: 'Cooling', workload: 'Workload', lead: 'Lead', supervisor: 'Supervisor' };

const ROUTE_RE = new RegExp(`^\\s*(${TEAM_KINDS.join('|')})\\s+(${TEAM_PARTIES.join('|')})->(${TEAM_PARTIES.join('|')})(?:\\s+(.*?))?\\s*$`, 's');

export const isTeamMessage = (call: Pick<ToolCallSummary, 'tool'>): boolean => call.tool === TEAM_MESSAGE_TOOL;

/** `<kind> <from>-><to>[ more tokens]` → parsed route; any other tool or malformed args → null. */
export function parseTeamArgs(args: string): ParsedTeamMessage | null {
  const m = ROUTE_RE.exec(args);
  if (!m) return null;
  return { kind: m[1] as TeamKind, from: m[2] as TeamParty, to: m[3] as TeamParty, extra: m[4] ? m[4] : null };
}

export function parseTeamMessage(call: Pick<ToolCallSummary, 'tool' | 'args_summary'>): ParsedTeamMessage | null {
  return isTeamMessage(call) ? parseTeamArgs(call.args_summary) : null;
}

/** The first well-formed `team_message` call of an event, or null. */
export function teamMessageOf(calls: readonly Pick<ToolCallSummary, 'tool' | 'args_summary'>[]): ParsedTeamMessage | null {
  for (const call of calls) {
    const parsed = parseTeamMessage(call);
    if (parsed) return parsed;
  }
  return null;
}

/** Drops the `Cooling → Workload: ` / `Cooling covering for Workload: ` head the agent writes into the feed summary. */
export function stripTeamHead(summary: string): string {
  return summary.replace(/^(?:Cooling|Workload|Lead|Supervisor) (?:→ (?:Cooling|Workload|Lead|Supervisor)|covering for (?:Cooling|Workload|Lead)): /, '');
}
