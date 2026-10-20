// The labweaver folder, ~/.labweaver (same name as src/labweaver-dir.ts).
import { homedir } from "node:os";
import { join } from "node:path";

export const LABWEAVER_HOME = join(homedir(), ".labweaver");
