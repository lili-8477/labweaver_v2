// URL of a path nginx serves next to the app (/upload/, /download/, …).
// Relative to Vite's base so a build served under a prefix (e.g.
// `vite build --base /v2/`) reaches its own nginx, not the root site's.
export function hubPath(path: string): string {
  return import.meta.env.BASE_URL + path
}
