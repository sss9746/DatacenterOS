// Tool registry: the only surface Nemotron can call. Read-only; unknown tools / bad args never throw.

import { z } from 'zod';
import type { LlmToolDef } from '../ports.js';
import { getIncidentEvidenceTool } from './evidence-tool.js';
import { listPlacementCandidatesTool } from './placement-tool.js';
import { getActionStatusTool, proposePlanTool, simulatePlanTool } from './plan-tools.js';
import { getJobStateTool, getResourceDependenciesTool } from './topology-tools.js';
import { ToolError, clipSummary, type ToolDeps, type ToolResult, type ToolSpec } from './types.js';

const ALL_TOOLS: ToolSpec<any>[] = [
  getIncidentEvidenceTool,
  getResourceDependenciesTool,
  getJobStateTool,
  listPlacementCandidatesTool,
  simulatePlanTool,
  proposePlanTool,
  getActionStatusTool,
];

export const TOOL_NAMES = ALL_TOOLS.map((t) => t.name);

export interface ToolRegistry {
  definitions: LlmToolDef[];
  invoke(name: string, argumentsJson: string): Promise<ToolResult>;
}

const fail = (name: string, error: string): ToolResult => ({
  ok: false,
  error,
  summary: clipSummary(`${name}: ${error}`),
});

const toDefinition = (t: ToolSpec<any>): LlmToolDef => {
  const { $schema: _omit, ...parameters } = z.toJSONSchema(t.schema, { io: 'input' }) as Record<string, unknown>;
  return { name: t.name, description: t.description, parameters };
};

const formatZod = (e: z.ZodError): string =>
  e.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ');

export function createToolRegistry(deps: ToolDeps): ToolRegistry {
  const full = { ...deps, workflowId: deps.workflowId ?? `wf-${deps.runId}` };
  const byName = new Map(ALL_TOOLS.map((t) => [t.name, t]));

  return {
    definitions: ALL_TOOLS.map(toDefinition),
    async invoke(name, argumentsJson) {
      const tool = byName.get(name);
      if (!tool) return fail(name, `unknown tool (available: ${TOOL_NAMES.join(', ')})`);
      let raw: unknown;
      try {
        raw = argumentsJson.trim() === '' ? {} : JSON.parse(argumentsJson);
      } catch {
        return fail(name, 'arguments are not valid JSON');
      }
      const parsed = tool.schema.safeParse(raw);
      if (!parsed.success) return fail(name, `invalid arguments: ${formatZod(parsed.error)}`);
      try {
        const out = await tool.run(parsed.data, full);
        return { ok: true, data: out.data, summary: clipSummary(out.summary) };
      } catch (e) {
        if (e instanceof ToolError) return fail(name, e.message);
        // Unexpected failure: keep a short model-safe message, never a stack trace.
        return fail(name, `internal error: ${e instanceof Error ? e.message.slice(0, 120) : 'unknown'}`);
      }
    },
  };
}
