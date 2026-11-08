// Machine-readable JSON per case + one short markdown report per run. Everything passes through the
// redactor before it is written. Pure except `writeArtifacts`.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Check } from './asserts.js';
import type { CaseId } from './args.js';
import type { Redactor } from './redact.js';

export interface RunMeta {
  harness: 'live-recovery-test';
  commit: string;
  branch: string | null;
  db: string;
  run_id: string;
  seed: number;
  speed: number;
  preset_id: string;
  /** Model name only (never a key). `deterministic` when --no-llm. */
  model: string;
  llm_mode: 'live_nim' | 'deterministic_no_llm' | 'forced_unreachable_nim';
  reset_performed: boolean;
  started_unix_ms: number;
  node: string;
  platform: string;
}

export interface TimelineEntry {
  wall_unix_ms: number;
  sim_time_ms: number | null;
  event: string;
  detail?: Record<string, unknown>;
}

export interface AgentGenerationRecord {
  generation: number;
  pid: number;
  /** AGENT_NAME / AGENT_ZONE of the child (null: default identity, any zone). */
  name: string | null;
  zone: string | null;
  started_unix_ms: number;
  ended_unix_ms: number | null;
  how_ended: 'SIGKILL' | 'taskkill' | 'exited' | 'stopped_by_harness' | 'running' | 'already_exited';
  exit_code: number | null;
  stderr_tail: string[];
}

export interface CaseArtifact {
  case: CaseId;
  title: string;
  /** `live` = real DB + real agent process; `deterministic` labels a --no-llm rehearsal. */
  evidence_label: string;
  passed: boolean;
  failure_reasons: string[];
  started_unix_ms: number;
  ended_unix_ms: number;
  sim_start_ms: number | null;
  sim_end_ms: number | null;
  command_keys: Record<string, string | null>;
  checks: Check[];
  allocation_uniqueness: { ok: boolean; doubled: Record<string, string[]> } | null;
  checkpoint_count: { job_id: string; complete_before: number; complete_after: number } | null;
  verification: Record<string, unknown> | null;
  agent_generations: AgentGenerationRecord[];
  /** L7/L8: agent-to-agent messages read back from the agent_event rows (from/to/topic/text), oldest first. */
  messages: MessageRecord[];
  timeline: TimelineEntry[];
  /** Last snapshot summary when the case failed (bounded; redacted). */
  last_snapshot_summary: Record<string, unknown> | null;
  /** Ledger rows (status + command, no secrets) at the end of the case. */
  ledger: Array<Record<string, unknown>>;
  error: string | null;
}

export interface MessageRecord {
  sim_time_ms: number;
  from: string;
  to: string;
  topic: string;
  workflow_id: string | null;
  text: string;
}

export interface RunArtifact {
  meta: RunMeta;
  cases: CaseArtifact[];
  passed: boolean;
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));

export function renderMarkdown(run: RunArtifact): string {
  const m = run.meta;
  const lines: string[] = [];
  lines.push(`# R5 live recovery harness report`);
  lines.push('');
  lines.push(`- **Result:** ${run.passed ? 'PASS' : 'FAIL'} (${run.cases.filter((c) => c.passed).length}/${run.cases.length} cases)`);
  lines.push(`- **Commit:** \`${m.commit}\`${m.branch ? ` (${m.branch})` : ''}`);
  lines.push(`- **Database:** \`${m.db}\` run \`${m.run_id}\` preset \`${m.preset_id}\` seed ${m.seed} speed ${m.speed}; reset performed: ${m.reset_performed ? 'yes' : 'no'}`);
  lines.push(`- **Model:** ${m.model} (${m.llm_mode}${m.llm_mode !== 'live_nim' ? ' — NOT a Nemotron claim' : ''})`);
  lines.push(`- **Started:** ${new Date(m.started_unix_ms).toISOString()} on ${m.platform} ${m.node}`);
  lines.push('');
  lines.push('| Case | Result | Evidence | Sim window | Wall s | Checks |');
  lines.push('|---|---|---|---|---|---|');
  for (const c of run.cases) {
    const okN = c.checks.filter((x) => x.ok).length;
    const sim = c.sim_start_ms !== null && c.sim_end_ms !== null ? `${c.sim_start_ms / 1000}s → ${c.sim_end_ms / 1000}s` : '-';
    lines.push(`| ${c.case} ${c.title} | ${c.passed ? 'PASS' : 'FAIL'} | ${c.evidence_label} | ${sim} | ${((c.ended_unix_ms - c.started_unix_ms) / 1000).toFixed(0)} | ${okN}/${c.checks.length} |`);
  }
  lines.push('');
  for (const c of run.cases) {
    lines.push(`## ${c.case} — ${c.title}: ${c.passed ? 'PASS' : 'FAIL'}`);
    lines.push('');
    if (c.failure_reasons.length) {
      lines.push('**Why it failed:**');
      for (const r of c.failure_reasons) lines.push(`- ${r}`);
      lines.push('');
    }
    if (c.error) {
      lines.push(`**Error:** ${c.error}`);
      lines.push('');
    }
    const keys = Object.entries(c.command_keys).filter(([, v]) => v);
    if (keys.length) {
      lines.push('**Command keys:** ' + keys.map(([k, v]) => `${k}=\`${v}\``).join(', '));
      lines.push('');
    }
    if (c.checkpoint_count) lines.push(`**Checkpoints (${c.checkpoint_count.job_id}):** complete ${c.checkpoint_count.complete_before} → ${c.checkpoint_count.complete_after}`);
    if (c.allocation_uniqueness) lines.push(`**Allocation uniqueness:** ${c.allocation_uniqueness.ok ? 'ok' : `DOUBLED ${JSON.stringify(c.allocation_uniqueness.doubled)}`}`);
    if (c.verification) lines.push(`**Verification:** \`${JSON.stringify(c.verification)}\``);
    lines.push('');
    lines.push('```');
    for (const k of c.checks) lines.push(`${k.ok ? 'PASS' : 'FAIL'}  ${pad(k.name, 48)} ${k.detail}`);
    lines.push('```');
    if (c.agent_generations.length) {
      lines.push('');
      lines.push('**Agent processes:** ' + c.agent_generations.map((g) => `gen${g.generation}${g.name ? ` ${g.name}` : ''}${g.zone ? `@${g.zone}` : ''} pid ${g.pid} (${g.how_ended}${g.exit_code !== null ? ` code ${g.exit_code}` : ''})`).join('; '));
    }
    if (c.messages.length) {
      lines.push('');
      lines.push('**Agent messages:**');
      lines.push('');
      lines.push('```');
      for (const m of c.messages) lines.push(`sim=${m.sim_time_ms} ${m.from} -> ${m.to} [${m.topic}]${m.workflow_id ? ` ${m.workflow_id}` : ''}: ${m.text}`);
      lines.push('```');
    }
    if (c.timeline.length) {
      lines.push('');
      lines.push('<details><summary>Timeline</summary>');
      lines.push('');
      lines.push('```');
      for (const t of c.timeline) lines.push(`${new Date(t.wall_unix_ms).toISOString()} sim=${t.sim_time_ms ?? '-'} ${t.event}${t.detail ? ' ' + JSON.stringify(t.detail) : ''}`);
      lines.push('```');
      lines.push('</details>');
    }
    lines.push('');
  }
  lines.push('_Ledger success alone is not recovery evidence; see per-case verification and the browser witness from R4._');
  return lines.join('\n');
}

export interface WrittenPaths {
  dir: string;
  runJson: string;
  caseJson: string[];
  markdown: string;
}

/** Write `<out>/run.json`, `<out>/<case>.json` and `<out>/report.md`, all redacted. */
export function writeArtifacts(outDir: string, run: RunArtifact, redact: Redactor): WrittenPaths {
  mkdirSync(outDir, { recursive: true });
  // Artifacts hold DB state (redacted, but still run data): keep them out of git without touching the root .gitignore.
  writeFileSync(join(outDir, '.gitignore'), '*\n');
  const safeRun = redact.value(run);
  const runJson = join(outDir, 'run.json');
  writeFileSync(runJson, JSON.stringify(safeRun, bigintSafe, 2));
  const caseJson: string[] = [];
  for (const c of safeRun.cases) {
    const p = join(outDir, `${c.case}.json`);
    writeFileSync(p, JSON.stringify({ meta: safeRun.meta, ...c }, bigintSafe, 2));
    caseJson.push(p);
  }
  const markdown = join(outDir, 'report.md');
  writeFileSync(markdown, redact(renderMarkdown(safeRun)));
  return { dir: outDir, runJson, caseJson, markdown };
}

export const bigintSafe = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v);
