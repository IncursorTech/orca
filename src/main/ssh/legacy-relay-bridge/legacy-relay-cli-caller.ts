/**
 * Who a relay-era terminal's `orca` command speaks as, and what it may reach.
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15.
 *
 * Everything the host sends is a claim. The caller is accepted only as a pane this desktop leased
 * on that host, which its relay still runs, and which this desktop's orchestration records bind to
 * the claimed handle (as a Dispatch assignee or a Run coordinator). It then reaches only its own
 * mailboxes, its own Dispatch or Run, and the other party of that same orchestration.
 */
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { OrchestrationDb } from '../../runtime/orchestration/db'
import { isEquivalentPaneKey } from '../../runtime/orchestration/db/pane-key-match'
import type { DispatchContextRow, RunRow } from '../../runtime/orchestration/types'
import type { LegacyRelayLivePane } from './legacy-relay-bridge-leases'

const MAX_IDENTITY_LENGTH = 512

export const LEGACY_RELAY_CLI_UNVERIFIED =
  "Orca could not confirm this terminal is one of this host's supervised Orca terminals, so its " +
  'orca command was refused. Run it in a new terminal on this host.'

export type LegacyRelayCliCaller = {
  handle: string
  paneKey: string
  ptyId: string
  processIncarnation?: string
  /** The Dispatch this pane holds as its assignee. */
  dispatch?: DispatchContextRow
  /** The Run this pane coordinates. */
  run?: RunRow
}

export type LegacyRelayCliCall = { method: string; params: Record<string, unknown> }

function bounded(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed && trimmed.length <= MAX_IDENTITY_LENGTH ? trimmed : undefined
}

function samePane(recorded: string | null | undefined, paneKey: string): boolean {
  return recorded ? isEquivalentPaneKey(recorded, paneKey) : false
}

export function resolveLegacyRelayCliCaller(
  runtime: OrcaRuntimeService,
  env: Readonly<Record<string, string>>,
  livePane: (paneKey: string) => LegacyRelayLivePane | null,
  /** A retry of a mutation this caller already completed, which may outlive its Dispatch. */
  replay?: { fingerprint: string; requestId: string }
): LegacyRelayCliCaller {
  const handle = bounded(env.ORCA_TERMINAL_HANDLE)
  const paneKey = bounded(env.ORCA_PANE_KEY)
  const pane = handle && paneKey && parsePaneKey(paneKey) ? livePane(paneKey) : null
  if (!handle || !paneKey || !pane) {
    throw new Error(LEGACY_RELAY_CLI_UNVERIFIED)
  }
  // The relay names the handle it launched the pane with; a different claim is someone else's.
  if (pane.terminalHandle && pane.terminalHandle !== handle) {
    throw new Error(LEGACY_RELAY_CLI_UNVERIFIED)
  }
  // A handle this runtime hosts elsewhere belongs to that terminal, never to a relay pane.
  const hostedPane = runtime.getTerminalPaneKey(handle)
  if (hostedPane && !isEquivalentPaneKey(hostedPane, paneKey)) {
    throw new Error(LEGACY_RELAY_CLI_UNVERIFIED)
  }
  const db = runtime.getOrchestrationDb()
  const dispatch = resolveOwnDispatch(db, handle, paneKey, replay)
  const run = resolveCoordinatedRun(db, handle, paneKey)
  if (!dispatch && !run) {
    throw new Error(LEGACY_RELAY_CLI_UNVERIFIED)
  }
  return {
    handle,
    paneKey,
    ptyId: pane.ptyId,
    ...(pane.incarnationId ? { processIncarnation: `${pane.ptyId}:${pane.incarnationId}` } : {}),
    ...(dispatch ? { dispatch } : {}),
    ...(run ? { run } : {})
  }
}

/** The Dispatch this pane holds; a settled one only to replay a result it already committed. */
function resolveOwnDispatch(
  db: OrchestrationDb,
  handle: string,
  paneKey: string,
  replay: { fingerprint: string; requestId: string } | undefined
): DispatchContextRow | undefined {
  const own = (row: DispatchContextRow | undefined) =>
    row?.assignee_handle === handle && samePane(row.assignee_pane_key, paneKey) ? row : undefined
  const active = own(db.getActiveDispatchForIdentity(handle, paneKey))
  if (active || !replay) {
    return active
  }
  if (db.getMutationReceipt(replay.fingerprint, replay.requestId)?.state === 'completed') {
    return own(db.getLatestDispatchForTerminal(handle))
  }
  // A legacy worker's results live in legacy receipts, under the principal it settled as.
  const adoption = db.getLegacyAdoption()
  const principal = adoption
    ? db.resolveLegacyCompatibilityPrincipalByIdentity({
        runId: adoption.adopted_run_id,
        role: 'worker',
        paneKey
      })
    : undefined
  return principal?.status === 'settled' && principal.terminal_handle === handle
    ? own(principal.dispatch_id ? db.getDispatchContextById(principal.dispatch_id) : undefined)
    : undefined
}

/** The Run this pane coordinates, including a migrated Run's retained legacy coordinator. */
function resolveCoordinatedRun(
  db: OrchestrationDb,
  handle: string,
  paneKey: string
): RunRow | undefined {
  const bound = db.getCurrentRunForPane(paneKey)
  if (bound) {
    return bound.coordinator_handle === handle ? bound : undefined
  }
  const adopted = db.getLegacyAdoption()?.adopted_run_id
  return adopted &&
    db.resolveLegacyCoordinatorCandidate({ runId: adopted, terminalHandle: handle, paneKey })
    ? db.getRun(adopted)
    : undefined
}

function outside(subject: string): Error {
  return new Error(
    `A terminal started by an older version of Orca can reach only its own orchestration, and ${subject} is outside it.`
  )
}

function stringParam(params: Record<string, unknown>, name: string): string | undefined {
  const value = params[name]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function payloadDispatchId(payload: string | undefined): string | undefined {
  if (!payload) {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(payload)
    return parsed && typeof parsed === 'object' && 'dispatchId' in parsed
      ? typeof parsed.dispatchId === 'string'
        ? parsed.dispatchId
        : undefined
      : undefined
  } catch {
    // The handler owns malformed payloads; nothing here names a Dispatch.
    return undefined
  }
}

/** A Dispatch the caller is a party to: its own, or one in the Run it coordinates on this host. */
function isPartyDispatch(
  db: OrchestrationDb,
  caller: LegacyRelayCliCaller,
  dispatchId: string,
  livePane: (paneKey: string) => LegacyRelayLivePane | null
): boolean {
  if (dispatchId === caller.dispatch?.id) {
    return true
  }
  const named = db.getDispatchContextById(dispatchId)
  return Boolean(
    caller.run &&
    named?.run_id === caller.run.id &&
    named.assignee_pane_key &&
    livePane(named.assignee_pane_key)
  )
}

function ownedAddresses(caller: LegacyRelayCliCaller): Set<string> {
  return new Set([
    caller.handle,
    ...(caller.dispatch ? [`dispatch:${caller.dispatch.id}`] : []),
    ...(caller.run ? [`run:${caller.run.id}`] : [])
  ])
}

function isAllowedRecipient(
  db: OrchestrationDb,
  caller: LegacyRelayCliCaller,
  to: string,
  livePane: (paneKey: string) => LegacyRelayLivePane | null
): boolean {
  if (ownedAddresses(caller).has(to)) {
    return true
  }
  const dispatch = caller.dispatch
  if (dispatch) {
    const coordinator = db.getRun(dispatch.run_id)?.coordinator_handle
    if (
      to === `run:${dispatch.run_id}` ||
      (dispatch.creator_handle && to === dispatch.creator_handle) ||
      (coordinator && to === coordinator) ||
      db.isLegacyCoordinatorDeliveryTarget(dispatch.run_id, to)
    ) {
      return true
    }
  }
  if (to.startsWith('dispatch:')) {
    return isPartyDispatch(db, caller, to.slice('dispatch:'.length), livePane)
  }
  const worker = caller.run ? db.getActiveDispatchForIdentity(to) : undefined
  return Boolean(worker && isPartyDispatch(db, caller, worker.id, livePane))
}

/** Throws unless the call stays inside the caller's own orchestration. */
export function assertLegacyRelayCliScope(
  db: OrchestrationDb,
  caller: LegacyRelayCliCaller,
  call: LegacyRelayCliCall,
  livePane: (paneKey: string) => LegacyRelayLivePane | null
): void {
  const { method, params } = call
  const selfParam = method === 'orchestration.check' || method === 'orchestration.inbox'
  const named = stringParam(params, selfParam ? 'terminal' : 'from')
  if (named !== caller.handle) {
    throw outside(`terminal '${named ?? ''}'`)
  }
  const run = stringParam(params, 'run')
  if (run && run !== caller.dispatch?.run_id && run !== caller.run?.id) {
    throw outside(`run '${run}'`)
  }
  if (method === 'orchestration.reply') {
    const id = stringParam(params, 'id') ?? ''
    const original = db.getMessageById(id)
    if (!original || !ownedAddresses(caller).has(original.to_handle)) {
      throw outside(`message '${id}'`)
    }
    return
  }
  if (method !== 'orchestration.send' && method !== 'orchestration.ask') {
    return
  }
  const dispatchId = payloadDispatchId(stringParam(params, 'payload'))
  if (dispatchId && !isPartyDispatch(db, caller, dispatchId, livePane)) {
    throw outside(`dispatch '${dispatchId}'`)
  }
  const to = stringParam(params, 'to')
  if (to && !isAllowedRecipient(db, caller, to, livePane)) {
    throw outside(`recipient '${to}'`)
  }
}
