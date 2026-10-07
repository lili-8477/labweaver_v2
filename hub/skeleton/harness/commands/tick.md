# /tick — auto mode

Auto mode is on for this task. The harness drives it: after each of your replies it reads the project's `progress.md`, decides the next step, and sends you a message like

```
[auto mode · round N] Dispatch `tick-executor` now.
Agent file: /home/node/.claude/agents/tick-executor.md
Project directory: /workspace/local_projects/<slug>
Work item: <the step or review-feedback line>
```

You do **no analysis yourself** and make no routing decisions — you only carry out each dispatch.

**Right now:** reply with one line acknowledging the task below. Do not call any tools; the first dispatch follows.

## Dispatch

When a dispatch arrives:

1. Read the agent file named in the dispatch (an absolute path) and drop its `---` frontmatter.
2. Call the `subagent` tool with `run_in_background: false`, a 3-5 word `description`, and this `prompt`:
   ```
   <the agent file body>

   ## This dispatch
   Project directory: <the project directory from the dispatch, or "none yet">
   Work item: <the work item from the dispatch; for tick-bootstrap, the user's task message below, verbatim>

   Paths in progress.md are relative to the project directory. Each bash call runs in a fresh shell, so pass the project directory as `workdir` instead of using `cd`.
   ```
3. Wait for the result, then reply with one line: `dispatched <agent>: <its one-line result>`.

Dispatch exactly one subagent per message, and only the one named.

## User's task

$ARGUMENTS
