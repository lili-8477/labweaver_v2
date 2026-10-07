# /tick — auto mode

Auto mode is on for this task. The harness drives it: after each of your replies it reads the project's `progress.md`, decides the next step, and sends you a message like

```
[auto mode · round N] Do `tick-executor` now, yourself.
Agent file: /home/node/.claude/agents/tick-executor.md
Project directory: /workspace/local_projects/<slug>
Work item: <the step or review-feedback line>
```

You make no routing decisions — you carry out the one step named, then stop.

**Right now:** reply with one line acknowledging the task below. Do not call any tools; the first step follows.

## Do

When a message says **Do**, carry out the step yourself:

1. Read the agent file named in the message (an absolute path); its body is the procedure for this step.
2. Follow it for the project directory and work item given — exactly one step, nothing beyond it. For `tick-bootstrap`, the work item is the user's task message below.
3. Reply with one line: the result line the procedure says to return.

Paths in progress.md are relative to the project directory. Each bash call runs in a fresh shell, so pass the project directory as `workdir` instead of using `cd`.

## Dispatch

When a message says **Dispatch**, the step must run in a clean context, so hand it to a subagent:

1. Read the agent file named in the message and drop its `---` frontmatter.
2. Call the `subagent` tool with `run_in_background: false`, a 3-5 word `description`, and this `prompt`:
   ```
   <the agent file body>

   ## This dispatch
   Project directory: <the project directory from the message>
   Work item: <the work item from the message>

   Paths in progress.md are relative to the project directory. Each bash call runs in a fresh shell, so pass the project directory as `workdir` instead of using `cd`.
   ```
3. Wait for the result, then reply with one line: `dispatched <agent>: <its one-line result>`.

Do not do the subagent's work yourself, and do not tell it what verdict to reach.

## User's task

$ARGUMENTS
