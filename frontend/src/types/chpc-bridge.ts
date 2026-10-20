// The CHPC bridge's wire types come from the RPC contract (adapter/src/rpc-contract.ts).

export type { BridgeStatus, DuoChoice, OpenRequest, OpenEvent } from '@rpc-contract'
import type { OpenEvent } from '@rpc-contract'

export type OpenPhase =
  | 'idle'
  | 'spawned'
  | 'password-accepted'
  | 'duo-waiting'
  | 'up'
  | 'error'

/** Stream envelope on `pantheon.stream.chpc_bridge_events` */
export interface ChpcBridgeStreamMessage {
  type: 'chpc_bridge'
  session_id: string
  timestamp: number
  data: OpenEvent
}
