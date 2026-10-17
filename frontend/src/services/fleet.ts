import { natsService } from './nats'

/** One container's report (adapter/src/fleet-status.ts ContainerStatus). */
export interface ContainerStatus {
  username: string
  role: 'manager' | 'user'
  hostname: string
  startedAt: number
  reportedAt: number
  memoryBytes: number
  memoryLimitBytes: number | null
  cpuPercent: number | null
  cpus: number
  activeTurns: number
  kernels: number
}

export interface FleetEntry {
  username: string
  online: boolean
  status: ContainerStatus | null
}

export const fleetService = {
  /** True when this adapter is the manager container. Older adapters lack the RPC. */
  isManager: async (): Promise<boolean> => {
    try {
      const r = await natsService.invoke('get_role', {}) as { manager: boolean }
      return r.manager
    } catch {
      return false
    }
  },

  list: async (): Promise<FleetEntry[]> => {
    const r = await natsService.invoke('fleet_status', {}) as { containers: FleetEntry[] }
    return r.containers
  },
} as const
