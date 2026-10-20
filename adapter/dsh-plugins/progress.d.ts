// Types for progress.js (plain ESM, loaded by dsh and bundled into the adapter).

export type NextStep = { agent: string; work: string; complete?: undefined } | { complete: true };

export interface ProgressStep {
  /** First word after the box (and the optional `(reviewed)` marker). */
  name:        string;
  /** Rest of the line up to ` | ` (which separates description from evidence). */
  description: string;
  done:        boolean;
  reviewed:    boolean;
}

export interface ParsedProgress {
  pipeline:        string | null;
  steps:           ProgressStep[];
  complete:        boolean;
  /** Open (☐) lines under `## Review feedback`; the executor takes these first. */
  pendingFeedback: number;
  /** The plan step that runs next (nextStep's choice), or null when the next work is not a plan step. */
  nextStepIndex:   number | null;
  /** The agent that runs next: tick-executor, tick-reviewer, …; null when complete. */
  nextAgent:       string | null;
}

export function section(md: string, title: string): string[] | null;
export function nextStep(md: string | null): NextStep;
export function parseProgress(md: string): ParsedProgress;
export function verdict(md: string | null, line: string): "success" | "failure" | null;
