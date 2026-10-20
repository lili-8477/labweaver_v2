/**
 * h5ad viewer RPC client (types: the RPC contract, adapter/src/rpc-contract.ts):
 *   h5ad_introspect(path)         → metadata for picking what to plot
 *   h5ad_plot(path, kind, params) → { png } base64 PNG
 *
 * Plot calls can take several seconds on first load (AnnData read), then
 * cached. Pick a generous timeout.
 */

import { natsService } from './nats'
import type { H5adIntrospection, PlotKind } from '@rpc-contract'

export type { H5adIntrospection, ObsColumn, PlotKind, SpatialInfo } from '@rpc-contract'

export interface PlotResult {
  png: string  // base64-encoded PNG (no data: prefix)
}

const PLOT_TIMEOUT_MS = 180_000

export async function introspectH5ad(path: string): Promise<H5adIntrospection> {
  const res = await natsService.invoke('h5ad_introspect', { path }, PLOT_TIMEOUT_MS)
  if (!res?.success) {
    throw new Error('h5ad_introspect failed')
  }
  return res
}

export async function plotH5ad(
  path: string,
  kind: PlotKind,
  params: Record<string, unknown> = {},
): Promise<PlotResult> {
  const res = await natsService.invoke('h5ad_plot', { path, kind, params }, PLOT_TIMEOUT_MS)
  if (!res?.success || !res.png) {
    throw new Error('h5ad_plot failed')
  }
  return { png: res.png }
}
