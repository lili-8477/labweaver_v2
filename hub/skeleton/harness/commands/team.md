# /team — team mode

Team mode is on for this chat: the user asks you to use Agent Teams for the task below. You are the Team Lead.

1. **Decide whether a team helps.** For a quick question or a one-step change, just answer it yourself. Otherwise split the work into a few parts that can proceed in parallel or need an independent check: for example an analyst who runs the pipeline, a reviewer who checks each result, a writer who drafts the report.
2. **Build the team.** Create each teammate with `spawn_teammate`: a short lowercase name, its role, and a self-contained first task (teammates start without this conversation unless forked). Keep it small: two to four teammates.
3. **Put the plan on the board.** Add one `team_task_create` per piece of work, with dependencies where order matters and the files each task will write, so teammates don't edit the same files.
4. **Coordinate.** Use `send_message` to hand over context and `wait_agent` to wait for progress; re-check `list_agents` and `team_task_list` after each wake-up. Have a reviewer check results before they are final.
5. **Finish.** When the tasks are done, check the results yourself, then reply to the user with what the team did and where the outputs are.

## User's task

$ARGUMENTS
