// Lists the browser halves of dsh plugins installed in the acp profile
// (`dsh plugin --profile acp add <pkg>`), so the frontend can host them the
// way dsh's own web UI does. A package opts in with `dsh.client.platform:
// "web"` in its package.json; its bundle is the file at `exports["./client"]`,
// a `window.__ModuleLoader__.load({ id, factory })` envelope. Read-only walk;
// returns [] when the profile has no such plugins.

import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export interface ClientModule {
  /** Package name, e.g. "@skillre/dsh-plugin-pomodoro". */
  id:   string;
  /** The bundle source: one `window.__ModuleLoader__.load(...)` call. */
  code: string;
}

/** The acp profile directory, where `dsh plugin --profile acp add` installs. */
export function acpProfileDir(home: string): string {
  return join(process.env.DSH_HOME ?? join(home, ".dsh"), "profiles", "acp");
}

async function readJson(path: string): Promise<Record<string, any> | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function listClientModules(profileDir: string): Promise<ClientModule[]> {
  const profile = await readJson(join(profileDir, "package.json"));
  const out: ClientModule[] = [];
  for (const name of Object.keys(profile?.dependencies ?? {}).sort()) {
    const pkgDir = resolve(profileDir, "node_modules", name);
    const pkg = await readJson(join(pkgDir, "package.json"));
    if (pkg?.dsh?.client?.platform !== "web") continue;
    const entry = pkg.exports?.["./client"];
    const rel = typeof entry === "string" ? entry : entry?.default;
    if (typeof rel !== "string") continue;
    const file = resolve(pkgDir, rel);
    if (!file.startsWith(pkgDir + sep)) continue; // the bundle must live inside its package
    try {
      out.push({ id: pkg.name ?? name, code: await readFile(file, "utf8") });
    } catch (e) {
      // Declared but not built (e.g. a git install whose build did not run).
      console.warn(`[dsh-client] ${name}: cannot read ${rel}:`, (e as Error).message);
    }
  }
  return out;
}
