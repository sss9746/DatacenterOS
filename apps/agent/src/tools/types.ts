// Shared types for the read-only LLM tool layer (LANE-P3 P3-2).
// Nemotron can only call these tools; none of them executes an action (request_action is coordinator-only).

import type { ZodType } from 'zod';
import type { DbPort, PhysicsPort } from '../ports.js';

export type ToolResult =
  | { ok: true; data: unknown; summary: string }
  | { ok: false; error: string; summary: string };

export interface ToolDeps {
  db: DbPort;
  physics: PhysicsPort;
  /** Defaults to `wf-${runId}` when absent. */
  workflowId?: string;
  runId: string;
}

/** What a tool body returns; the registry wraps it into a ToolResult. */
export interface ToolOutput {
  data: unknown;
  summary: string;
}

/** Thrown by a tool body to report a clean, model-readable failure (never leaks stack traces). */
export class ToolError extends Error {}

export interface ToolSpec<A = unknown> {
  name: string;
  description: string;
  schema: ZodType<A>;
  run(args: A, deps: ToolDeps & { workflowId: string }): Promise<ToolOutput>;
}

export const SUMMARY_MAX_CHARS = 160;

export const clipSummary = (s: string, max = SUMMARY_MAX_CHARS): string =>
  s.length <= max ? s : `${s.slice(0, max - 1)}…`;
