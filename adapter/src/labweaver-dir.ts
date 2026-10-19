// The labweaver folder (GLOSSARY.md): a user's skills, commands, agents,
// hooks, settings.json, Auto markers and session transcripts, in one place.
// Mounted at <workspace>/.labweaver; ~/.labweaver links to it (entrypoint.sh).
// dsh-plugins/labweaver-dir.js holds the same name for the plugins.

import * as path from "node:path";

export const LABWEAVER_DIR = ".labweaver";

/** <home>/.labweaver/<parts…> */
export function labweaverPath(home: string, ...parts: string[]): string {
  return path.join(home, LABWEAVER_DIR, ...parts);
}
