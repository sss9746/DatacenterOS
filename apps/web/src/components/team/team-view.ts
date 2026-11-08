// Pure, tolerant reader for the agent-team trace persisted on `workflow.state` (`team`, `team_rounds`, `recovery`,
// `operator_jobs`). Everything shown on the Team stage, transcript and recovery timeline comes from here. Nothing is
// inferred beyond what the trace records: a v1 trace has no per-call timing, so its timing reads "not recorded".
// Malformed input returns null; nothing here throws.

export const TEAM_ROLES = ['cooling', 'workload', 'lead'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];
export type TeamParty = TeamRole | 'supervisor';
export const TEAM_KINDS = ['question', 'answer', 'finding', 'objection', 'cover', 'decision'] as const;
export type TeamKind = (typeof TEAM_KINDS)[number];
export const TEAM_PHASES = ['findings', 'peer_answers', 'cover', 'decide', 'closed'] as const;
export type TeamPhase = (typeof TEAM_PHASES)[number];
export type CallStatus = 'running' | 'ok' | 'timeout' | 'rejected' | 'failed';

/** Agent default budget (`team/round.ts`): used only when a v1 trace did not persist its own. */
export const DEFAULT_BUDGET = { max_calls: 6, round_ms: 30_000, call_timeout_ms: null as number | null };

export interface TeamMessageView {
  id: string;
  /** Position in the persisted order (1-based): the order the round recorded, which is chronological. */
  seq: number;
  /** Raw party ids; an unknown sender reads as "unattributed", never as a model. */
  from: TeamParty | 'unattributed';
  to: TeamParty | 'unattributed';
  kind: TeamKind | 'unknown';
  replyTo: string | null;
  summary: string;
  evidenceIds: string[];
  resourceIds: string[];
  consumedBy: TeamRole[];
  /** The recipient is a role and its next model input contained this message. Null when the recipient is code. */
  consumedByRecipient: boolean | null;
  /** Findings, answers and covers are model claims and can be wrong. */
  claim: boolean;
  /** A question with no recorded answer in this round. */
  unanswered: boolean;
  /** ms from round start (v2), else null. */
  tMs: number | null;
}

export interface TeamCallView { role: TeamRole; phase: TeamPhase | 'unknown'; startedMs: number; endedMs: number | null; status: CallStatus }

export type NodeState = 'thinking' | 'done' | 'timed_out' | 'rejected' | 'failed' | 'covering' | 'missing' | 'idle' | 'not_called';
export interface RoleNode {
  role: TeamRole;
  state: NodeState;
  /** Short state word(s): "timed out". */
  stateLabel: string;
  /** Readable state with coverage, e.g. "timed out · covered by Cooling". */
  label: string;
  /** Roles this one covered for in this round. */
  coveredFor: TeamRole[];
  coveredBy: TeamRole | null;
  calls: number;
}

export interface TeamEdge {
  key: string;
  from: TeamParty;
  to: TeamParty;
  messageIds: string[];
  kinds: TeamKind[];
  /** 'consumed' every message reached the recipient's input; 'none' none did; 'partial' some; 'code' the recipient is code. */
  consumption: 'consumed' | 'none' | 'partial' | 'code';
  notConsumed: number;
}

export interface CoverView { failedRole: TeamRole; coveredBy: TeamRole; cause: string; messageId: string | null }

export interface TeamRoundView {
  /** Unique per run: round id + start time (a takeover reruns the same round id), else round id + position. */
  key: string;
  roundId: string;
  /** "a2 · e3" from `${wf}:a${attempt}:e${epoch}`; the raw id when it does not parse. */
  label: string;
  attempt: number | null;
  epoch: number | null;
  version: 1 | 2;
  /** v2 status; v1 traces were written only after the round ended, so they are closed. 'not_closed' = an older v2 round still marked running. */
  status: 'running' | 'closed' | 'interrupted' | 'not_closed';
  phase: TeamPhase | null;
  timing: 'recorded' | 'not recorded';
  snapshotSimMs: number | null;
  startedUnixMs: number | null;
  model: string | null;
  callsUsed: number;
  wallMs: number;
  budget: { maxCalls: number; roundMs: number; callTimeoutMs: number | null; source: 'trace' | 'default' };
  outcome: 'lead' | 'deterministic' | null;
  /** Who decided: 'Lead (Nemotron)', 'Lead (model …)', 'deterministic code', or 'not decided yet'. */
  decider: string;
  messages: TeamMessageView[];
  calls: TeamCallView[];
  nodes: Record<TeamRole, RoleNode>;
  edges: TeamEdge[];
  covers: CoverView[];
  missingRoles: TeamRole[];
}

export interface TeamView {
  /** Oldest first; the last one is the latest. */
  rounds: TeamRoundView[];
  /** Rounds the agent dropped from `team_rounds` (it keeps the last 4). */
  dropped: number;
}

export interface RecoveryInfo {
  status: string;
  jobIds: string[];
  blockedReason: string | null;
  firstWaitUnixMs: number | null;
  attempts: number | null;
  freeGpus: number | null;
}

export interface OperatorJob { jobId: string; reason: string | null }

// ------------------------------------------------------------------------------------------------ primitives

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : []);
const isRole = (v: unknown): v is TeamRole => typeof v === 'string' && (TEAM_ROLES as readonly string[]).includes(v);
const isParty = (v: unknown): v is TeamParty => isRole(v) || v === 'supervisor';
const isKind = (v: unknown): v is TeamKind => typeof v === 'string' && (TEAM_KINDS as readonly string[]).includes(v);
const isPhase = (v: unknown): v is TeamPhase => typeof v === 'string' && (TEAM_PHASES as readonly string[]).includes(v);
const CALL_STATUSES: readonly CallStatus[] = ['running', 'ok', 'timeout', 'rejected', 'failed'];
const isCallStatus = (v: unknown): v is CallStatus => typeof v === 'string' && (CALL_STATUSES as readonly string[]).includes(v);

export const ROLE_LABEL: Record<TeamRole, string> = { cooling: 'Cooling', workload: 'Workload', lead: 'Lead' };
export const partyLabel = (p: string): string => (isRole(p) ? ROLE_LABEL[p] : p === 'supervisor' ? 'Code supervisor' : 'unattributed');
const CLAIM_KINDS: ReadonlySet<string> = new Set(['finding', 'answer', 'cover']);

export function parseRoundId(roundId: string): { attempt: number | null; epoch: number | null; label: string } {
  const m = /:a(\d+):e(\d+)$/.exec(roundId);
  if (!m) return { attempt: null, epoch: null, label: roundId };
  return { attempt: Number(m[1]), epoch: Number(m[2]), label: `a${m[1]} · e${m[2]}` };
}

// ------------------------------------------------------------------------------------------------ round reader

function readMessages(raw: unknown): TeamMessageView[] {
  const list = Array.isArray(raw) ? raw.filter(isRecord) : [];
  const out: TeamMessageView[] = [];
  list.forEach((m, i) => {
    const id = str(m.id) ?? `message-${i + 1}`;
    const from = isParty(m.from) ? m.from : 'unattributed';
    const to = isParty(m.to) ? m.to : 'unattributed';
    const kind = isKind(m.kind) ? m.kind : 'unknown';
    const consumedBy = strList(m.consumed_by).filter(isRole);
    out.push({
      id, seq: i + 1, from, to, kind, replyTo: str(m.reply_to), summary: typeof m.summary === 'string' ? m.summary : '',
      evidenceIds: strList(m.evidence_ids), resourceIds: strList(m.resource_ids), consumedBy,
      consumedByRecipient: isRole(to) ? consumedBy.includes(to) : null,
      claim: CLAIM_KINDS.has(kind), unanswered: false, tMs: num(m.t_ms),
    });
  });
  const answered = new Set(out.filter((m) => m.replyTo).map((m) => m.replyTo));
  for (const m of out) if (m.kind === 'question' && !answered.has(m.id)) m.unanswered = true;
  // v2 carries per-message timing: keep chronological order when every message has it; otherwise persisted order.
  if (out.length && out.every((m) => m.tMs !== null)) out.sort((a, b) => (a.tMs as number) - (b.tMs as number) || a.seq - b.seq);
  return out;
}

function readCalls(raw: unknown): TeamCallView[] {
  if (!Array.isArray(raw)) return [];
  const out: TeamCallView[] = [];
  for (const c of raw) {
    if (!isRecord(c) || !isRole(c.role) || !isCallStatus(c.status)) continue;
    const startedMs = num(c.started_ms);
    if (startedMs === null) continue;
    out.push({ role: c.role, phase: isPhase(c.phase) ? c.phase : 'unknown', startedMs, endedMs: num(c.ended_ms), status: c.status });
  }
  return out.sort((a, b) => a.startedMs - b.startedMs);
}

const CALL_NODE_STATE: Record<CallStatus, NodeState> = { running: 'thinking', ok: 'done', timeout: 'timed_out', rejected: 'rejected', failed: 'failed' };
export const NODE_LABEL: Record<NodeState, string> = {
  thinking: 'thinking', done: 'done', timed_out: 'timed out', rejected: 'finding rejected', failed: 'call failed',
  covering: 'covering', missing: 'no usable output', idle: 'waiting its turn', not_called: 'not called',
};

function causeFor(role: TeamRole, calls: TeamCallView[]): string {
  const last = [...calls].reverse().find((c) => c.role === role && c.status !== 'ok' && c.status !== 'running');
  if (!last) return 'did not deliver a usable finding';
  return last.status === 'timeout' ? 'timed out' : last.status === 'rejected' ? 'finding was rejected by code' : 'call failed';
}

function buildNodes(version: 1 | 2, status: TeamRoundView['status'], messages: TeamMessageView[], calls: TeamCallView[], covers: CoverView[], missing: TeamRole[], outcome: TeamRoundView['outcome']): Record<TeamRole, RoleNode> {
  const nodes = {} as Record<TeamRole, RoleNode>;
  for (const role of TEAM_ROLES) {
    const coveredFor = covers.filter((c) => c.coveredBy === role).map((c) => c.failedRole);
    const coveredBy = covers.find((c) => c.failedRole === role)?.coveredBy ?? null;
    const mine = calls.filter((c) => c.role === role);
    let state: NodeState;
    if (version === 2 && calls.length) {
      const last = mine.at(-1);
      if (!last) state = status === 'running' ? 'idle' : missing.includes(role) ? 'missing' : 'not_called';
      else if (last.status === 'running') state = last.phase === 'cover' || coveredFor.length ? 'covering' : 'thinking';
      else state = CALL_NODE_STATE[last.status];
      // A role that failed earlier but later succeeded keeps its latest state; a failed role stays failed.
    } else {
      const spoke = messages.some((m) => m.from === role);
      if (coveredBy) state = 'failed';
      else if (missing.includes(role)) state = 'missing';
      else if (spoke) state = 'done';
      else if (role === 'lead' && outcome === 'deterministic') state = 'missing';
      else state = status === 'running' ? 'idle' : 'not_called';
    }
    if (coveredBy && (state === 'done' || state === 'not_called')) state = 'failed';
    const stateLabel = state === 'failed' && coveredBy && version === 1 ? 'no usable finding' : NODE_LABEL[state];
    let label = stateLabel;
    if (coveredBy) label = `${label} · covered by ${ROLE_LABEL[coveredBy]}`;
    if (coveredFor.length && state !== 'covering') label = `${label} · covered for ${coveredFor.map((r) => ROLE_LABEL[r]).join(', ')}`;
    nodes[role] = { role, state, stateLabel, label, coveredFor, coveredBy, calls: mine.length };
  }
  return nodes;
}

function buildEdges(messages: TeamMessageView[], outcome: TeamRoundView['outcome']): TeamEdge[] {
  const byKey = new Map<string, TeamEdge>();
  for (const m of messages) {
    if (m.from === 'unattributed' || m.to === 'unattributed' || m.from === m.to) continue;
    const key = `${m.from}->${m.to}`;
    const edge = byKey.get(key) ?? { key, from: m.from, to: m.to, messageIds: [], kinds: [], consumption: 'consumed' as TeamEdge['consumption'], notConsumed: 0 };
    edge.messageIds.push(m.id);
    if (m.kind !== 'unknown' && !edge.kinds.includes(m.kind)) edge.kinds.push(m.kind);
    if (m.consumedByRecipient === false) edge.notConsumed += 1;
    byKey.set(key, edge);
  }
  for (const e of byKey.values()) {
    if (e.to === 'supervisor') e.consumption = e.kinds.includes('decision') && outcome === 'deterministic' ? 'none' : 'code';
    else e.consumption = e.notConsumed === 0 ? 'consumed' : e.notConsumed === e.messageIds.length ? 'none' : 'partial';
  }
  return [...byKey.values()];
}

function deciderOf(outcome: TeamRoundView['outcome'], model: string | null, status: TeamRoundView['status']): string {
  if (outcome === 'deterministic') return 'deterministic code';
  if (outcome === 'lead') return model && /nemotron/i.test(model) ? 'Lead (Nemotron)' : model ? `Lead (model ${model})` : 'Lead (model not recorded)';
  return status === 'running' ? 'not decided yet' : status === 'interrupted' ? 'no decision (round interrupted)' : 'not recorded';
}

/** One persisted TeamTrace → round view. Null when it is not a trace (no round id or no messages array). */
export function readTeamRound(raw: unknown): TeamRoundView | null {
  try {
    if (!isRecord(raw)) return null;
    const roundId = str(raw.round_id);
    if (!roundId || !Array.isArray(raw.messages)) return null;
    const version: 1 | 2 = raw.version === 2 ? 2 : 1;
    const rawStatus = raw.status;
    const status: TeamRoundView['status'] = version === 2 && (rawStatus === 'running' || rawStatus === 'closed' || rawStatus === 'interrupted') ? rawStatus : 'closed';
    const messages = readMessages(raw.messages);
    const calls = version === 2 ? readCalls(raw.calls) : [];
    const outcome = raw.outcome === 'lead' || raw.outcome === 'deterministic' ? (status === 'running' || status === 'interrupted' ? null : raw.outcome) : null;
    const missingRoles = strList(raw.missing_roles).filter(isRole);
    const coverRecords = (Array.isArray(raw.covers) ? raw.covers : []).filter(isRecord).filter((c) => isRole(c.failed_role) && isRole(c.covered_by)) as Array<{ failed_role: TeamRole; covered_by: TeamRole }>;
    const covers: CoverView[] = coverRecords.map((c) => ({
      failedRole: c.failed_role, coveredBy: c.covered_by, cause: causeFor(c.failed_role, calls),
      messageId: messages.find((m) => m.kind === 'cover' && m.from === c.covered_by)?.id ?? null,
    }));
    const budgetRaw = isRecord(raw.budget) ? raw.budget : null;
    const maxCalls = num(budgetRaw?.max_calls);
    const roundMs = num(budgetRaw?.round_ms);
    const { attempt, epoch, label } = parseRoundId(roundId);
    const model = str(raw.model);
    return {
      key: roundId, roundId, label, attempt, epoch, version, status,
      phase: isPhase(raw.phase) ? raw.phase : null,
      timing: version === 2 && (calls.length > 0 || messages.some((m) => m.tMs !== null)) ? 'recorded' : 'not recorded',
      snapshotSimMs: num(raw.snapshot_sim_ms), startedUnixMs: num(raw.started_unix_ms), model,
      callsUsed: num(raw.calls_used) ?? calls.length, wallMs: num(raw.wall_ms) ?? 0,
      budget: { maxCalls: maxCalls ?? DEFAULT_BUDGET.max_calls, roundMs: roundMs ?? DEFAULT_BUDGET.round_ms, callTimeoutMs: num(budgetRaw?.call_timeout_ms), source: maxCalls !== null && roundMs !== null ? 'trace' : 'default' },
      outcome, decider: deciderOf(outcome, model, status),
      messages, calls,
      nodes: buildNodes(version, status, messages, calls, covers, missingRoles, outcome),
      edges: buildEdges(messages, outcome),
      covers, missingRoles,
    };
  } catch {
    return null;
  }
}

/** `state.team` (latest) + `state.team_rounds.rounds` (history, oldest first), deduplicated by round id. Null when none parse. */
export function readTeam(state: unknown): TeamView | null {
  try {
    if (!isRecord(state)) return null;
    const history = isRecord(state.team_rounds) && Array.isArray(state.team_rounds.rounds) ? state.team_rounds.rounds : [];
    const dropped = isRecord(state.team_rounds) ? (num(state.team_rounds.dropped) ?? 0) : 0;
    // A run is identified by round id + start time: after a takeover the same round id is rerun, and the interrupted
    // run stays in history beside the rerun. v1 traces have no start time, so they fall back to round id + position.
    const order: string[] = [];
    const byKey = new Map<string, TeamRoundView>();
    history.forEach((raw, pos) => {
      const r = readTeamRound(raw);
      if (!r) return;
      r.key = r.startedUnixMs !== null ? `${r.roundId}@${r.startedUnixMs}` : `${r.roundId}#${pos}`;
      if (!byKey.has(r.key)) order.push(r.key);
      byKey.set(r.key, r);
    });
    const latest = readTeamRound(state.team);
    if (latest) {
      // `state.team` is the freshest copy of the latest run: it replaces the same run in history, never a different one.
      const sameUntimed = latest.startedUnixMs === null ? [...order].reverse().find((k) => { const h = byKey.get(k)!; return h.roundId === latest.roundId && h.startedUnixMs === null; }) : undefined;
      latest.key = latest.startedUnixMs !== null ? `${latest.roundId}@${latest.startedUnixMs}` : sameUntimed ?? `${latest.roundId}#latest`;
      if (!byKey.has(latest.key)) order.push(latest.key);
      byKey.set(latest.key, latest);
    }
    if (!order.length) return null;
    const rounds = order.map((k) => byKey.get(k)!);
    const repeated = new Map<string, number>();
    for (const r of rounds) repeated.set(r.roundId, (repeated.get(r.roundId) ?? 0) + 1);
    const seenRun = new Map<string, number>();
    for (const r of rounds) {
      if ((repeated.get(r.roundId) ?? 0) < 2) continue;
      const n = (seenRun.get(r.roundId) ?? 0) + 1;
      seenRun.set(r.roundId, n);
      r.label = `${r.label} · run ${n}`;
    }
    // Only the latest round can still be running; an older one still marked running never recorded its close.
    rounds.forEach((r, i) => { if (i < rounds.length - 1 && r.status === 'running') { r.status = 'not_closed'; r.outcome = null; r.decider = deciderOf(r.outcome, r.model, r.status); } });
    return { rounds, dropped };
  } catch {
    return null;
  }
}

/** `state.recovery` (RecoveryRecord in agent-loop.ts). Null when absent or malformed. */
export function readRecovery(state: unknown): RecoveryInfo | null {
  if (!isRecord(state) || !isRecord(state.recovery)) return null;
  const r = state.recovery;
  const status = str(r.status);
  if (!status) return null;
  return { status, jobIds: strList(r.job_ids), blockedReason: str(r.blocked_reason), firstWaitUnixMs: num(r.first_wait_unix_ms), attempts: num(r.attempts), freeGpus: num(r.free_gpus) };
}

/** `state.operator_jobs`: jobs the planner says need a person. */
export function readOperatorJobs(state: unknown): OperatorJob[] {
  if (!isRecord(state) || !Array.isArray(state.operator_jobs)) return [];
  return state.operator_jobs.filter(isRecord).map((j) => ({ jobId: str(j.job_id) ?? 'unknown job', reason: str(j.reason) })).filter((j) => j.jobId !== 'unknown job' || j.reason !== null);
}

// ------------------------------------------------------------------------------------------------ recovery chapters

export type ChapterKind = 'round' | 'execute' | 'waiting' | 'takeover' | 'verify' | 'escalated';
export interface Chapter {
  key: string;
  kind: ChapterKind;
  title: string;
  detail: string;
  /** Sim time used only to order chapters (shown as text, never as an axis). */
  simMs: number | null;
  tone: 'neutral' | 'agent' | 'warning' | 'danger';
  /** For team rounds: the round, so the timeline can draw its own wall-time bars. */
  round?: TeamRoundView;
}

export interface ChapterInput {
  team: TeamView | null;
  /** Ledger actions of this workflow (persisted). */
  actions: ReadonlyArray<{ command: { command_key: string; plan_id: string; requested_sim_time_ms: number }; status: { status: string } }>;
  resumed: { sim_time_ms: number; previous_owner: string | null; by_worker: string | null; action: string | null } | null;
  verification: { verified: boolean | null; asOf: { from: number | null; to: number } | null; outcome: string | null } | null;
  recovery: RecoveryInfo | null;
  operatorJobs: OperatorJob[];
  stage: string;
  escalationReason: string | null;
}

const fmtSim = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s sim` : `${s} s sim`;
};
const stripPid = (w: string | null): string | null => (w ? w.replace(/-\d+$/, '') : null);

/**
 * Ordinal chapters for the whole workflow, from persisted state only. Order uses recorded sim times (team round
 * snapshot, first action request, takeover, verification); chapters without one keep their canonical place.
 */
export function buildChapters(input: ChapterInput): Chapter[] {
  const out: Chapter[] = [];
  for (const r of input.team?.rounds ?? []) {
    const status = r.status === 'running' ? 'running now' : r.status === 'interrupted' ? 'interrupted' : r.status === 'not_closed' ? 'close not recorded' : 'closed';
    const covers = r.covers.map((c) => `${ROLE_LABEL[c.failedRole]} ${c.cause}, ${ROLE_LABEL[c.coveredBy]} covered`).join('; ');
    out.push({
      key: `round-${r.key}`, kind: 'round', title: `Team round ${r.label}`, round: r, simMs: r.snapshotSimMs,
      detail: `${status} · ${r.callsUsed} model calls · decided by ${r.decider}${covers ? ` · ${covers}` : ''}`,
      tone: r.status === 'interrupted' ? 'danger' : r.covers.length ? 'warning' : 'neutral',
    });
  }
  const byPlan = new Map<string, typeof input.actions[number][]>();
  for (const a of input.actions) {
    const list = byPlan.get(a.command.plan_id);
    if (list) list.push(a); else byPlan.set(a.command.plan_id, [a]);
  }
  for (const [planId, list] of byPlan) {
    const done = list.filter((a) => a.status.status === 'succeeded').length;
    const active = list.filter((a) => ['requested', 'claimed', 'running'].includes(a.status.status)).length;
    const failed = list.length - done - active;
    out.push({
      key: `execute-${planId}`, kind: 'execute', title: 'Execute', simMs: Math.min(...list.map((a) => a.command.requested_sim_time_ms)),
      detail: `${list.length} ${list.length === 1 ? 'action' : 'actions'} in the ledger for plan ${planId}: ${done} succeeded${active ? `, ${active} in progress` : ''}${failed ? `, ${failed} failed or blocked` : ''}`,
      tone: failed ? 'warning' : 'neutral',
    });
  }
  if (input.resumed) {
    const from = stripPid(input.resumed.previous_owner);
    const by = stripPid(input.resumed.by_worker);
    out.push({
      key: 'takeover', kind: 'takeover', title: 'Agent stopped · takeover', simMs: input.resumed.sim_time_ms,
      detail: `${from ? `Lease of ${from} lapsed` : 'The previous agent stopped'}; ${by ? `${by} took over` : 'another agent took over'}${input.resumed.action ? ` (${input.resumed.action.replaceAll('_', ' ')})` : ''}. A restarted agent process is covered; a machine failure is not.`,
      tone: 'warning',
    });
  }
  // Sort what has sim times; keep the rest (none so far) stable.
  out.sort((a, b) => (a.simMs ?? Number.POSITIVE_INFINITY) - (b.simMs ?? Number.POSITIVE_INFINITY));
  if (input.recovery && input.recovery.status === 'waiting') {
    const since = input.recovery.firstWaitUnixMs !== null ? ` since ${new Date(input.recovery.firstWaitUnixMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })} wall` : '';
    out.push({
      key: 'waiting', kind: 'waiting', title: 'Waiting for capacity', simMs: null, tone: 'warning',
      detail: `Holding ${input.recovery.jobIds.length ? input.recovery.jobIds.join(', ') : 'jobs not recorded'}${since}${input.recovery.attempts !== null ? ` · check ${input.recovery.attempts}` : ''}${input.recovery.blockedReason ? ` · ${input.recovery.blockedReason}` : ''}`,
    });
  }
  if (input.operatorJobs.length) {
    out.push({
      key: 'operator', kind: 'escalated', title: 'Needs an operator', simMs: null, tone: 'danger',
      detail: input.operatorJobs.map((j) => `${j.jobId}${j.reason ? `: ${j.reason}` : ''}`).join('; '),
    });
  }
  const v = input.verification;
  if (v) {
    out.push({
      key: 'verify', kind: 'verify', title: v.verified === true ? 'Verified' : v.verified === false ? 'Verify · not confirmed' : 'Verify · result not recorded', simMs: v.asOf?.to ?? null,
      detail: `${v.outcome ? `${v.outcome.replaceAll('_', ' ')} · ` : ''}${v.asOf ? `evidence ${v.asOf.from !== null ? `${fmtSim(v.asOf.from)}–` : 'as of '}${fmtSim(v.asOf.to)}` : 'evidence time not recorded'} · deterministic verifier`,
      tone: v.verified === true ? 'agent' : 'danger',
    });
  } else if (input.stage === 'escalated') {
    out.push({ key: 'escalated', kind: 'escalated', title: 'Escalated to an operator', simMs: null, tone: 'danger', detail: input.escalationReason ?? 'Escalation reason not recorded.' });
  }
  return out;
}
