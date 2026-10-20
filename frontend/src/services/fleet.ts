import { natsService } from './nats'
import type { FleetEntry } from '@rpc-contract'

export type { ContainerStatus, FleetEntry } from '@rpc-contract'

export const fleetService = {
  /** True when this adapter is the manager container. Older adapters lack the RPC. */
  isManager: async (): Promise<boolean> => {
    try {
      return (await natsService.invoke('get_role')).manager
    } catch {
      return false
    }
  },

  list: async (): Promise<FleetEntry[]> => {
    return (await natsService.invoke('fleet_status')).containers
  },
} as const
