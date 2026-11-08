// One bounded agent-team round (plans/MULTI-AGENT-HACKATHON-PLAN.md §0.2), run inside planning in place of the single
// Nemotron choice: parallel findings, peer answers, at most one cover call, then the Lead calls choose_options.
// Specialists have no tool registry. Any failure degrades to `choices: null`, the planner's deterministic path.

import { AsyncLocalStorage } from 'node:async_hooks';
import { DEFAULT_LLM_COOLDOWN_MS, withLlmCircuitBreaker } from '../agent-loop.js';
import type { AgentConfig } from '../config.js';
import { summarizeToolCall } from '../events.js';
import { LlmUnavailableError, createNimLlm, type NimLlmEvent } from '../llm.js';
import { LLM_PAYLOAD_MAX_BYTES, LLM_TOP_OPTIONS, buildLlmPayload, collectChoices, type ChooserInput, type ChooserResult, type Choice, type OptionChooser } from '../planner.js';
import type { LlmChatRequest, LlmChatResponse, LlmMessage, LlmPort, LlmToolCall } from '../ports.js';
import { CHOOSE_OPTIONS_TOOL, CHOOSE_OPTIONS_TOOL_NAME, PLANNER_MAX_TOKENS } from '../prompts/planner.js';
import {
  TEAM_LIMITS,
  answerPeerArgsSchema,
  boundIds,
  boundSummary,
  boundTrace,
  submitFindingArgsSchema,
  type TeamCall,
  type TeamCallStatus,
  type TeamMessage,
  type TeamMessageKind,
  type TeamParty,
  type TeamPhase,
  type TeamRole,
  type TeamTrace,
  type TeamTraceStatus,
} from './protocol.js';
import {
  ANSWER_PEER_TOOL,
  ANSWER_PEER_TOOL_NAME,
  LEAD_SYSTEM_PROMPT,
  SPECIALIST_SYSTEM_PROMPT,
  SUBMIT_FINDING_TOOL,
  SUBMIT_FINDING_TOOL_NAME,
  buildCoverMessage,
  buildFindingMessage,
  buildLeadUserMessage,
  buildPeerQuestionMessage,
  packCoolingEvidence,
  packWorkloadEvidence,
  type InboxItem,
  type RoleBundle,
  type SpecialistRole,
} from './roles.js';

export const TEAM_BUDGET = {
  maxCalls: 6,
  // Raised from 8 s / 25 s / 9 s: live, Workload's Scene B prompt exceeded 8 s in repeated runs.
  callTimeoutMs: 12_000,
  roundMs: 30_000,
  leadReserveMs: 12_000,
  /** A call with less time than this left is not worth starting. */
  minCallMs: 1_000,
  specialistMaxTokens: 768,
} as const;

export interface TeamChooserDeps {
  /** Used to build the team LLM client when `llm` is not supplied. */
  cfg?: AgentConfig;
  /** Injected by tests (FakeLlm). */
  llm?: LlmPort;
  now: () => number;
  log?: (msg: string) => void;
}

const LABEL: Record<SpecialistRole, string> = { cooling: 'Cooling', workload: 'Workload' };
const SPECIALISTS: readonly SpecialistRole[] = ['cooling', 'workload'];
const peerOf = (r: SpecialistRole): SpecialistRole => (r === 'cooling' ? 'workload' : 'cooling');

/** Receives the adapter's events for the one call whose async context it is bound to. */
type CallObserver = (e: NimLlmEvent) => void;

interface Session {
  role: SpecialistRole;
  bundle: RoleBundle;
  messages: LlmMessage[];
}

interface Finding {
  message: TeamMessage;
  question: TeamMessage | null;
}

class TeamRound {
  private closed = false;
  private calls = 0;
  private phase: TeamPhase = 'findings';
  /** v2 per-call records; mutated only while the round is open. */
  private readonly callLog: TeamCall[] = [];
  private model: string | null = null;
  private seq = 0;
  private readonly messages: TeamMessage[] = [];
  private readonly covers: TeamTrace['covers'] = [];
  private readonly missing = new Set<TeamRole>();
  private readonly startedAt: number;
  private readonly specialistLimit: number;
  private readonly roundLimit: number;
  private readonly roundTimer: ReturnType<typeof setTimeout>;
  private readonly roundId: string;

  constructor(
    private readonly llm: LlmPort,
    private readonly scope: AsyncLocalStorage<CallObserver>,
    /** Worst-case model attempts for the Lead: 2 when the client may issue a corrective retry on its own. */
    private readonly leadAttempts: number,
    private readonly now: () => number,
    private readonly input: ChooserInput,
  ) {
    this.startedAt = now();
    this.roundLimit = this.startedAt + TEAM_BUDGET.roundMs;
    this.specialistLimit = this.roundLimit - TEAM_BUDGET.leadReserveMs;
    this.roundId = roundIdOf(input);
    this.roundTimer = setTimeout(() => this.close(), TEAM_BUDGET.roundMs);
    this.roundTimer.unref?.();
  }

  // ------------------------------------------------------------------------------------------ progress

  private elapsed(): number {
    return Math.max(0, this.now() - this.startedAt);
  }

  /**
   * Live progress: a copy of the trace so far, handed to `input.onProgress`. Synchronous and guarded, so a reporting
   * failure can neither throw into the round nor delay it. Nothing is reported once the round is closed.
   */
  private progress(): void {
    const report = this.input.onProgress;
    if (!report || this.closed) return;
    try {
      report(this.trace('running', null));
    } catch {
      // progress is best effort: the round's result never depends on it
    }
  }

  private enter(phase: TeamPhase): void {
    if (this.closed || this.phase === phase) return;
    this.phase = phase;
    this.progress();
  }

  private startCall(role: TeamRole): TeamCall {
    const call: TeamCall = { role, phase: this.phase, started_ms: this.elapsed(), ended_ms: null, status: 'running' };
    this.callLog.push(call);
    this.progress();
    return call;
  }

  private endCall(call: TeamCall, status: Exclude<TeamCallStatus, 'running'>): void {
    if (this.closed || call.status !== 'running') return;
    call.status = status;
    call.ended_ms = this.elapsed();
    this.progress();
  }

  /** Code refused the reply of `role`'s latest call (it ended `ok`): no tool call, invalid arguments or citations. */
  private refuseLatest(role: TeamRole): void {
    if (this.closed) return;
    const call = [...this.callLog].reverse().find((c) => c.role === role);
    if (call && call.status === 'ok') call.status = 'rejected';
  }

  /** A copy of the round as it stands. */
  private trace(status: TeamTraceStatus, choices: Choice[] | null): TeamTrace {
    return boundTrace({
      version: 2,
      round_id: this.roundId,
      snapshot_sim_ms: this.input.ix.snap.clock.sim_time_ms,
      model: this.model,
      calls_used: this.calls,
      wall_ms: this.elapsed(),
      outcome: choices ? 'lead' : 'deterministic',
      messages: this.messages.map((m) => ({ ...m, consumed_by: [...m.consumed_by] })),
      covers: this.covers.map((c) => ({ ...c })),
      missing_roles: [...this.missing],
      status,
      phase: status === 'closed' ? 'closed' : this.phase,
      started_unix_ms: this.startedAt,
      budget: { max_calls: TEAM_BUDGET.maxCalls, round_ms: TEAM_BUDGET.roundMs, call_timeout_ms: TEAM_BUDGET.callTimeoutMs },
      calls: this.callLog,
    });
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.roundTimer);
  }

  async run(): Promise<ChooserResult> {
    const { ix, incidents, evidence, ranked } = this.input;
    const bundles: Record<SpecialistRole, RoleBundle> = {
      cooling: packCoolingEvidence(ix, incidents, evidence),
      workload: packWorkloadEvidence(ix, incidents, evidence, [...ranked.keys()]),
    };
    const sessions = Object.fromEntries(
      SPECIALISTS.map((role) => [
        role,
        {
          role,
          bundle: bundles[role],
          messages: [
            { role: 'system', content: SPECIALIST_SYSTEM_PROMPT[role] },
            { role: 'user', content: buildFindingMessage(bundles[role]) },
          ],
        } satisfies Session,
      ]),
    ) as Record<SpecialistRole, Session>;

    this.progress(); // phase `findings`: the round has started
    const [cooling, workload] = await Promise.all(SPECIALISTS.map((r) => this.finding(sessions[r])));
    const findings: Record<SpecialistRole, Finding | null> = { cooling: cooling ?? null, workload: workload ?? null };
    for (const r of SPECIALISTS) if (!findings[r]) this.missing.add(r);

    await this.peerAnswers(sessions, findings);
    await this.cover(sessions, findings);
    return this.decide();
  }

  // ------------------------------------------------------------------------------------------ phases

  private async finding(session: Session): Promise<Finding | null> {
    const res = await this.call(this.specialistRequest(session, SUBMIT_FINDING_TOOL), this.specialistLimit, session.role, []);
    const tc = res && firstCall(res, SUBMIT_FINDING_TOOL_NAME);
    if (!tc) return this.unusable(session.role, res);
    const args = parseArgs(submitFindingArgsSchema, tc);
    if (!args) return this.reject(session.role, `finding rejected: invalid arguments (${invalidFields(submitFindingArgsSchema, tc)})`);
    const refused = unknownCitations(args, session.bundle.evidence_ids, session.bundle.resource_ids);
    if (refused) return this.reject(session.role, `finding rejected: ${refused}`);

    remember(session, tc);
    const message = this.post(session.role, 'lead', 'finding', args.summary, null, args.evidence_ids, args.resource_ids);
    const question = args.question_for_peer ? this.post(session.role, peerOf(session.role), 'question', args.question_for_peer, null, [], []) : null;
    return { message, question };
  }

  /**
   * One answer per question, in the recipient's own session. Sequential on purpose: when both specialists asked, the
   * first answer lands in the second answerer's input, and the budget can see a corrective retry before spending more.
   */
  private async peerAnswers(sessions: Record<SpecialistRole, Session>, findings: Record<SpecialistRole, Finding | null>): Promise<void> {
    for (const asker of SPECIALISTS) {
      const question = findings[asker]?.question;
      const responder = peerOf(asker);
      if (!question || !findings[responder] || !this.canRunSpecialist()) continue;
      const session = sessions[responder];
      this.enter('peer_answers');
      const pending = this.inboxFor(responder);
      session.messages.push({ role: 'user', content: buildPeerQuestionMessage(LABEL[asker], question.summary, pending.items) });
      const res = await this.call(this.specialistRequest(session, ANSWER_PEER_TOOL), this.specialistLimit, responder, [question, ...pending.messages]);
      const tc = res && firstCall(res, ANSWER_PEER_TOOL_NAME);
      if (!tc) {
        this.unusable(responder, res);
        continue;
      }
      const args = parseArgs(answerPeerArgsSchema, tc);
      if (!args) {
        this.reject(responder, `answer rejected: invalid arguments (${invalidFields(answerPeerArgsSchema, tc)})`);
        continue;
      }
      const refused = unknownCitations(args, session.bundle.evidence_ids, session.bundle.resource_ids);
      if (refused) {
        this.reject(responder, `answer rejected: ${refused}`);
        continue;
      }
      remember(session, tc);
      this.post(responder, asker, 'answer', args.answer, question.id, args.evidence_ids, args.resource_ids);
    }
  }

  /** At most one cover call, and only when exactly one specialist is left to do it. */
  private async cover(sessions: Record<SpecialistRole, Session>, findings: Record<SpecialistRole, Finding | null>): Promise<void> {
    const failed = SPECIALISTS.filter((r) => !findings[r]);
    if (failed.length !== 1 || !this.canRunSpecialist()) return;
    const failedRole = failed[0]!;
    const coverer = sessions[peerOf(failedRole)];
    const failedBundle = sessions[failedRole].bundle;
    this.enter('cover');
    const pending = this.inboxFor(coverer.role);
    coverer.messages.push({ role: 'user', content: buildCoverMessage(LABEL[failedRole], failedBundle, pending.items) });
    const res = await this.call(this.specialistRequest(coverer, SUBMIT_FINDING_TOOL), this.specialistLimit, coverer.role, pending.messages);
    const tc = res && firstCall(res, SUBMIT_FINDING_TOOL_NAME);
    if (!tc) {
      this.unusable(coverer.role, res);
      return;
    }
    const args = parseArgs(submitFindingArgsSchema, tc);
    if (!args) {
      this.reject(coverer.role, `cover rejected: invalid arguments (${invalidFields(submitFindingArgsSchema, tc)})`);
      return;
    }
    const evidence = new Set([...failedBundle.evidence_ids, ...coverer.bundle.evidence_ids]);
    const resources = new Set([...failedBundle.resource_ids, ...coverer.bundle.resource_ids]);
    const refused = unknownCitations(args, evidence, resources);
    if (refused) {
      this.reject(coverer.role, `cover rejected: ${refused}`);
      return;
    }
    this.post(coverer.role, 'lead', 'cover', args.summary, null, args.evidence_ids, args.resource_ids);
    this.covers.push({ failed_role: failedRole, covered_by: coverer.role });
    this.missing.delete(failedRole);
  }

  private async decide(): Promise<ChooserResult> {
    const { ix, incidents, ranked, toolCalls } = this.input;
    this.enter('decide');
    if (!this.canRunLead()) return this.deterministic('team budget exhausted before the Lead');

    const board = new Map(ranked);
    let payload = buildLlmPayload(ix, incidents, board, LLM_TOP_OPTIONS);
    if (payload.length > LLM_PAYLOAD_MAX_BYTES) payload = buildLlmPayload(ix, incidents, board, 2);
    const delivered = this.messages.filter((m) => m.kind === 'finding' || m.kind === 'cover' || m.kind === 'answer');
    const questions = delivered.flatMap((m) => {
      const q = m.kind === 'answer' ? this.messages.find((x) => x.id === m.reply_to) : undefined;
      return q ? [q] : [];
    });
    const teamInput = JSON.stringify({
      findings: delivered
        .filter((m) => m.kind !== 'answer')
        .map((m) => ({ from: m.from, kind: m.kind, summary: m.summary, evidence_ids: m.evidence_ids, resource_ids: m.resource_ids })),
      answers: delivered
        .filter((m) => m.kind === 'answer')
        .map((m) => ({
          from: m.from,
          to: m.to,
          question: this.messages.find((x) => x.id === m.reply_to)?.summary ?? null,
          answer: m.summary,
          evidence_ids: m.evidence_ids,
          resource_ids: m.resource_ids,
        })),
      covers: this.covers,
      missing_roles: [...this.missing],
    });

    const res = await this.call(
      {
        messages: [
          { role: 'system', content: LEAD_SYSTEM_PROMPT },
          { role: 'user', content: buildLeadUserMessage(teamInput, payload) },
        ],
        tools: [CHOOSE_OPTIONS_TOOL],
        toolChoice: 'required',
        maxTokens: PLANNER_MAX_TOKENS,
      },
      this.roundLimit,
      'lead',
      [...delivered, ...questions],
    );
    if (!res) return this.deterministic('LLM unavailable');

    const choices = collectChoices(res.toolCalls);
    if (!choices.some((c) => isEligible(c, ranked))) {
      this.refuseLatest('lead');
      return this.deterministic('invalid or missing choose_options call');
    }

    const decision = choices.map((c) => `${c.option_id}${c.needs_approval ? ' (approval)' : ''}`).join(', ');
    toolCalls.push(summarizeToolCall(CHOOSE_OPTIONS_TOOL_NAME, { jobs: ranked.size }, decision, 'nemotron'));
    this.post('lead', 'supervisor', 'decision', decision, null, [], []);
    return this.result(choices);
  }

  // ------------------------------------------------------------------------------------------ budget

  private hasTime(limit: number): boolean {
    return !this.closed && limit - this.now() >= TEAM_BUDGET.minCallMs;
  }

  /** Always leaves the Lead its worst-case attempts. */
  private canRunSpecialist(): boolean {
    return this.hasTime(this.specialistLimit) && this.calls + 1 + this.leadAttempts <= TEAM_BUDGET.maxCalls;
  }

  private canRunLead(): boolean {
    return this.hasTime(this.roundLimit) && this.calls + this.leadAttempts <= TEAM_BUDGET.maxCalls;
  }

  /**
   * One model call: resolves with the response, or null on failure, timeout or a closed round. The timer covers one
   * attempt, so a corrective retry (its own counted call) gets a fresh 8 s, always capped by `limit`. Anything that
   * arrives after the timer fired or the round closed is dropped here. `consumes` is recorded only once the input
   * is really being sent.
   */
  private call(req: LlmChatRequest, limit: number, role: TeamRole, consumes: readonly TeamMessage[]): Promise<LlmChatResponse | null> {
    if (this.closed) return Promise.resolve(null);
    this.calls += 1;
    const newlyConsumed = consumes.filter((m) => !m.consumed_by.includes(role));
    for (const m of newlyConsumed) m.consumed_by.push(role);
    let record = this.startCall(role);
    return new Promise((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (value: LlmChatResponse | null, status: Exclude<TeamCallStatus, 'running'>) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.endCall(record, status);
        resolve(this.closed ? null : value);
      };
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(null, 'timeout'), Math.max(0, Math.min(TEAM_BUDGET.callTimeoutMs, limit - this.now())));
        timer.unref?.();
      };
      const observe: CallObserver = (e) => {
        const extraAttempt = (e.type === 'tool_args_invalid' && e.corrective) || e.type === 'thinking_flag_rejected';
        if (!extraAttempt || this.closed) return;
        this.calls += 1;
        if (done) return;
        // The adapter's own corrective retry is a second model call: the first attempt ends here.
        this.endCall(record, e.type === 'thinking_flag_rejected' ? 'failed' : 'rejected');
        record = this.startCall(role);
        arm();
      };
      arm();
      this.scope.run(observe, () => this.llm.chat(req)).then(
        (res) => {
          if (!done && !this.closed) this.model = res.model;
          finish(res, 'ok');
        },
        (err: unknown) => {
          // An open circuit breaker never reached the endpoint: not a model call, and nothing was consumed.
          if (err instanceof LlmUnavailableError && err.attempts.length === 0 && !done && !this.closed) {
            this.calls -= 1;
            for (const m of newlyConsumed) m.consumed_by.splice(m.consumed_by.indexOf(role), 1);
            // Not a model call either: drop its record instead of leaving it `running` or calling it failed.
            done = true;
            clearTimeout(timer);
            const i = this.callLog.indexOf(record);
            if (i >= 0) this.callLog.splice(i, 1);
            this.progress();
            resolve(null);
            return;
          }
          finish(null, 'failed');
        },
      );
    });
  }

  private specialistRequest(session: Session, tool: typeof SUBMIT_FINDING_TOOL): LlmChatRequest {
    return { messages: session.messages.map((m) => ({ ...m })), tools: [tool], toolChoice: 'required', maxTokens: TEAM_BUDGET.specialistMaxTokens };
  }

  // ------------------------------------------------------------------------------------------ messages

  private post(from: TeamParty, to: TeamParty, kind: TeamMessageKind, summary: string, replyTo: string | null, evidenceIds: readonly string[], resourceIds: readonly string[]): TeamMessage {
    const message: TeamMessage = {
      id: `${this.roundId}:m${++this.seq}`,
      round_id: this.roundId,
      from,
      to,
      kind,
      reply_to: replyTo,
      summary: boundSummary(summary),
      evidence_ids: boundIds(evidenceIds, TEAM_LIMITS.evidenceIds),
      resource_ids: boundIds(resourceIds, TEAM_LIMITS.resourceIds),
      consumed_by: [],
      t_ms: this.elapsed(),
    };
    if (!this.closed) {
      this.messages.push(message);
      this.progress();
    }
    return message;
  }

  /** A reply without the expected tool call: its call is marked rejected. No objection is posted, as before. */
  private unusable(role: TeamRole, res: LlmChatResponse | null): null {
    if (res) this.refuseLatest(role);
    return null;
  }

  /** The reason is code-authored: rejected model text and ids are not repeated into the trace. */
  private reject(role: SpecialistRole, reason: string): null {
    this.refuseLatest(role);
    this.post('supervisor', role, 'objection', reason, null, [], []);
    return null;
  }

  /** Answers addressed to `role` that it has not seen yet. */
  private inboxFor(role: SpecialistRole): { items: InboxItem[]; messages: TeamMessage[] } {
    const messages = this.messages.filter((m) => m.to === role && m.kind === 'answer' && !m.consumed_by.includes(role));
    return { items: messages.map((m) => ({ from: m.from === 'cooling' || m.from === 'workload' ? LABEL[m.from] : m.from, text: m.summary })), messages };
  }

  // ------------------------------------------------------------------------------------------ result

  private deterministic(reason: string): ChooserResult {
    this.input.toolCalls.push(summarizeToolCall(CHOOSE_OPTIONS_TOOL_NAME, { jobs: this.input.ranked.size }, reason, 'code'));
    this.missing.add('lead');
    return this.result(null);
  }

  /** Closes the round first: the returned trace is a copy that nothing can touch afterwards. */
  result(choices: Choice[] | null): ChooserResult {
    // A call still open when the round ends (round deadline) ran out of time; it can no longer change anything.
    const end = this.elapsed();
    for (const c of this.callLog) {
      if (c.status !== 'running') continue;
      c.status = 'timeout';
      c.ended_ms = end;
    }
    this.close();
    return { choices, team: this.trace('closed', choices) };
  }

  /** The unexpected-error exit: same shape as any other failed round. */
  crashed(): ChooserResult {
    return this.deterministic('team round failed');
  }
}

const roundIdOf = (input: ChooserInput): string => `${input.workflowId}:a${input.attempt}:e${input.ix.snap.clock.decision_epoch}`;

const firstCall = (res: LlmChatResponse, name: string): LlmToolCall | undefined => res.toolCalls.find((c) => c.name === name);

function parseArgs<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, call: LlmToolCall): T | null {
  let raw: unknown;
  try {
    raw = JSON.parse(call.argumentsJson);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Schema field names that failed validation. Names come from the schema, so no model text reaches the trace. */
function invalidFields(schema: { safeParse(v: unknown): { success: boolean; error?: { issues: { path: PropertyKey[] }[] } } }, call: LlmToolCall): string {
  let raw: unknown;
  try {
    raw = JSON.parse(call.argumentsJson);
  } catch {
    return 'not JSON';
  }
  const issues = schema.safeParse(raw).error?.issues ?? [];
  return [...new Set(issues.map((i) => String(i.path[0] ?? 'arguments')))].join(', ') || 'unknown';
}

/**
 * Null when every citation exists in the bundle; otherwise a reason that repeats no model text. A real resource id
 * placed in evidence_ids (seen live from Nemotron) is moved to resource_ids in `args`, since it is still grounded in
 * the bundle. An id found in neither set is treated as invented and the whole reply is refused.
 */
function unknownCitations(args: { evidence_ids: string[]; resource_ids: string[] }, evidence: ReadonlySet<string>, resources: ReadonlySet<string>): string | null {
  const misfiled = args.evidence_ids.filter((id) => !evidence.has(id) && resources.has(id));
  const badEvidence = args.evidence_ids.filter((id) => !evidence.has(id) && !resources.has(id)).length;
  const badResources = args.resource_ids.filter((id) => !resources.has(id)).length;
  if (badEvidence > 0 || badResources > 0) return `${badEvidence} unknown evidence id(s), ${badResources} unknown resource id(s)`;
  args.evidence_ids = args.evidence_ids.filter((id) => evidence.has(id));
  args.resource_ids = [...new Set([...args.resource_ids, ...misfiled])];
  if (evidence.size > 0 && args.evidence_ids.length === 0 && misfiled.length === 0) return 'no evidence cited';
  return null;
}

/** Keeps the accepted tool call in the specialist's own session, so its next input is a real continuation. */
function remember(session: Session, call: LlmToolCall): void {
  session.messages.push({ role: 'assistant', content: null, toolCalls: [call] }, { role: 'tool', toolCallId: call.id, content: 'recorded' });
}

function isEligible(c: Choice, ranked: ChooserInput['ranked']): boolean {
  return (ranked.get(c.job_id) ?? []).some((o) => o.option_id === c.option_id && !o.excluded_reason);
}

export function createTeamChooser(deps: TeamChooserDeps): OptionChooser {
  const log = deps.log ?? (() => {});
  const scope = new AsyncLocalStorage<CallObserver>();
  let client: LlmPort | null = deps.llm ?? null;

  const getClient = (): LlmPort => {
    if (client) return client;
    if (!deps.cfg) throw new Error('team chooser has neither an llm nor a config');
    const nim = createNimLlm(
      { ...deps.cfg, LLM_TIMEOUT_MS: TEAM_BUDGET.callTimeoutMs },
      { maxRetries: 0, useFallback: false, onEvent: (e) => scope.getStore()?.(e) },
    );
    // Three consecutive failures: one slow specialist must not take the Lead down with it.
    client = withLlmCircuitBreaker(nim, DEFAULT_LLM_COOLDOWN_MS, deps.now, (e) => log(`team LLM circuit open: ${e.name}`), 3);
    return client;
  };

  // Only the real adapter retries on its own; an injected port is exactly one attempt per chat().
  const leadAttempts = deps.llm ? 1 : 2;

  return async (input) => {
    let llm: LlmPort;
    try {
      llm = getClient();
    } catch (e) {
      log(`team client unavailable: ${e instanceof Error ? e.name : 'error'}`);
      llm = { chat: () => Promise.reject(new LlmUnavailableError('no team LLM', [])) };
    }
    const round = new TeamRound(llm, scope, leadAttempts, deps.now, input);
    try {
      return await round.run();
    } catch (e) {
      log(`team round failed: ${e instanceof Error ? e.name : 'error'}`);
      return round.crashed();
    } finally {
      round.close();
    }
  };
}
