// progress.md, read in one place (GLOSSARY.md: Progress file). The tick
// plugin routes auto mode with nextStep; the adapter's get_harness_progress
// shows the UI parseProgress, whose next step is nextStep's answer — so the
// checklist highlights the step that will actually run. Plain ESM: dsh loads
// the plugins directory itself; progress.d.ts types it for the adapter.

/** Lines of a `## <title>` section, trimmed, or null when the section is absent. */
export function section(md, title) {
  const m = md.match(new RegExp(`^## ${title}(?:[ \\t][^\\n]*)?\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m"));
  return m ? m[1].split("\n").map((l) => l.trim()).filter(Boolean) : null;
}

// A plan or feedback line, with or without a leading "- ".
const OPEN = /^(?:-\s*)?☐/u;
const STEP = /^(?:-\s*)?([☑☐])\s*(?:\(reviewed\)\s*)?(\S+)(?:\s+(.*))?$/u;

/**
 * The tick priority: which agent runs next and on what, given progress.md
 * (null when the project does not exist yet). Returns { agent, work }, or
 * { complete: true } when every step is reviewed and the retrospective is done.
 */
export function nextStep(md) {
  if (md == null) return { agent: "tick-bootstrap", work: "the user's task message that started this auto-mode run (quote it verbatim)" };
  if (/^## Status: complete/m.test(md)) return { complete: true };
  const plan = section(md, "Plan") ?? [];
  if (plan.length === 0) return { agent: "tick-planner", work: "instantiate the plan from the pipeline template" };
  const feedback = (section(md, "Review feedback") ?? []).find((l) => OPEN.test(l));
  if (feedback) return { agent: "tick-executor", work: feedback };
  const unreviewed = plan.find((l) => l.includes("☑") && !l.includes("(reviewed)"));
  if (unreviewed) return { agent: "tick-reviewer", work: unreviewed };
  const todo = plan.find((l) => l.includes("☐"));
  if (todo) return { agent: "tick-executor", work: todo };
  if (!/^## Retrospective: done/m.test(md)) return { agent: "tick-retrospective", work: "the finished project" };
  return { complete: true };
}

/** The UI's view of progress.md: the plan's steps and what runs next. */
export function parseProgress(md) {
  const steps = [];
  const lines = [];
  for (const line of section(md, "Plan") ?? []) {
    const m = STEP.exec(line);
    if (!m) continue;
    // The description stops at " | ", which starts the step's evidence.
    steps.push({
      name:        m[2] ?? "",
      description: ((m[3] ?? "").split(/\s*\|\s*/, 1)[0] ?? "").trim(),
      done:        m[1] === "☑",
      reviewed:    /\(reviewed\)/.test(line),
    });
    lines.push(line);
  }
  const next = nextStep(md);
  const index = next.complete ? -1 : lines.indexOf(next.work);
  return {
    pipeline:        section(md, "Pipeline")?.[0] ?? null,
    steps,
    complete:        !!next.complete,
    pendingFeedback: (section(md, "Review feedback") ?? []).filter((l) => OPEN.test(l)).length,
    nextStepIndex:   index === -1 ? null : index,
    nextAgent:       next.complete ? null : next.agent,
  };
}
