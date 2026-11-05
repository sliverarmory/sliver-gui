import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse } from "yaml";

export interface WorkflowStep {
  readonly name?: string;
  readonly run?: string;
  readonly shell?: string;
  readonly if?: string;
  readonly env?: Record<string, string>;
  readonly "timeout-minutes"?: number;
}

export interface Workflow {
  readonly jobs: Record<string, {
    readonly needs?: string | string[];
    readonly if?: string;
    readonly steps?: WorkflowStep[];
  }>;
}

export const repositoryRoot = resolve(import.meta.dirname, "../..");

export function readWorkflow(name: string): Workflow {
  return parse(readFileSync(resolve(repositoryRoot, ".github/workflows", name), "utf8")) as Workflow;
}

export function workflowStep(workflow: Workflow, name: string): WorkflowStep {
  const matches = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []).filter((step) => step.name === name);
  if (matches.length !== 1) throw new Error(`Expected exactly one workflow step: ${name}`);
  return matches[0]!;
}

export function workflowScript(workflow: Workflow, name: string): string {
  const script = workflowStep(workflow, name).run;
  if (!script) throw new Error(`Missing executable workflow step: ${name}`);
  return script;
}
