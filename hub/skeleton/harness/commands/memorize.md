# /memorize — pin a fact to long-term memory

Persist the user's text to long-term memory using the labweaver-memory MCP server.

## Procedure

1. Treat `$ARGUMENTS` (everything after `/memorize`) as the memory body verbatim.
2. Call the MCP tool `memory_write` (server: `labweaver-memory`) with:
   - `body` — the full `$ARGUMENTS` text.
   - `name` — derived from the first line of the body (≤80 chars; trim, drop trailing punctuation).
   - `description` — a one-sentence paraphrase of the body (≤200 chars). If the body is already short, reuse the first line.
   - `scope` — default `"user"`. Use `"project"` only if the user explicitly says "for this project" or the text obviously refers to the current working directory.
   - `type` — infer from context: `"user"` (a fact the user wants remembered), `"feedback"` (a correction or stylistic preference), `"project"` (a project decision or finding), or `"reference"` (a pointer to a dataset, paper or doc).
   - `dir` — omit; the memory is filed by scope and type. Pass `"project/decisions"` (with `scope: "project"`) only when the user is recording a decision for this project.
3. Report back the returned `memory_id` in one line so the user can `/forget <id>` if needed.

Do not paraphrase or summarize the body before writing — the user picked the wording deliberately.
