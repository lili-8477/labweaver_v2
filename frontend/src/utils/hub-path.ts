// URL of a path nginx serves next to the app (/upload/, /download/, …).
// Relative to Vite's base so a build served under a prefix (e.g.
// `vite build --base /v2/`) reaches its own nginx, not the root site's.
export function hubPath(path: string): string {
  return import.meta.env.BASE_URL + path
}

const SERVICE_COOKIE = 'lw_service'

/** Hand nginx the service ID for its file routes (/upload/, /download/,
 *  /share-snapshot/). They route to the user's container by this cookie,
 *  which the browser sends on plain links too. Pass '' to clear it. */
export function setHubService(serviceId: string): void {
  const attrs = `path=${import.meta.env.BASE_URL}; SameSite=Strict${location.protocol === 'https:' ? '; Secure' : ''}`
  document.cookie = serviceId
    ? `${SERVICE_COOKIE}=${encodeURIComponent(serviceId)}; ${attrs}; max-age=31536000`
    : `${SERVICE_COOKIE}=; ${attrs}; max-age=0`
}
