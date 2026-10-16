import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toAppSshPtyId } from '../../../shared/ssh-pty-id'
import Database from '../../sqlite/sync-database'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { OrchestrationDb } from '../../runtime/orchestration/db'
import { createRootDispatch } from '../../runtime/orchestration/db/root-dispatch-test-fixture'
import { createLegacyRelayCliServer } from './legacy-relay-cli-server'

const TARGET = 'target-1'
const WORKER = 'term_relay_worker'
const WORKER_PANE = 'tab_w:33333333-3333-4333-8333-333333333333'
const PTY_ID = toAppSshPtyId(TARGET, 'pty-7')

let dir: string | undefined
let db: OrchestrationDb | undefined

afterEach(() => {
  db?.close()
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
  }
  db = undefined
  dir = undefined
})

/** A desktop whose orchestration records predate the current contract (schema 18). */
function legacyRuntime(): { runtime: OrcaRuntimeService; database: OrchestrationDb } {
  dir = mkdtempSync(join(tmpdir(), 'orca-legacy-relay-records-'))
  const path = join(dir, 'orchestration.db')
  const before = new OrchestrationDb(path)
  const task = before.createTask({
    runId: 'run_legacy_local',
    spec: 'legacy assignment',
    createdByTerminalHandle: 'term_legacy_coord'
  })
  createRootDispatch(before, task.id, WORKER, WORKER_PANE)
  before.close()
  const raw = new Database(path)
  raw.exec(`
    UPDATE dispatch_contexts SET process_incarnation = '${PTY_ID}:inc-1';
    DROP INDEX IF EXISTS idx_messages_delivery_contract;
    DROP TABLE legacy_mail_receipts;
    DROP TABLE legacy_operation_receipts;
    DROP TABLE legacy_compatibility_principals;
    DROP TABLE legacy_adoptions;
  `)
  raw.pragma('user_version = 18')
  raw.close()
  const database = new OrchestrationDb(path)
  db = database
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(database)
  vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
  return { runtime, database }
}

describe('the relay-era orca CLI on migrated legacy orchestration records', () => {
  it('attests the bridge-verified worker instead of answering read-only', async () => {
    const { runtime, database } = legacyRuntime()
    expect(database.getLegacyAdoption()).toBeTruthy()
    const server = createLegacyRelayCliServer({
      targetId: TARGET,
      runtime: () => runtime,
      remoteCliControl: () => true,
      livePane: (paneKey) =>
        paneKey === WORKER_PANE
          ? { ptyId: PTY_ID, incarnationId: 'inc-1', terminalHandle: WORKER }
          : null
    })
    const env = {
      ORCA_TERMINAL_HANDLE: WORKER,
      ORCA_PANE_KEY: WORKER_PANE,
      ORCA_AGENT_LAUNCH_TOKEN: 'worker-token'
    }
    const result = await server.cli(
      { argv: ['orchestration', 'check', '--json'], env },
      new AbortController().signal
    )
    expect(result).toMatchObject({ exitCode: 0 })
    const stdout = result && typeof result === 'object' && 'stdout' in result ? result.stdout : ''
    expect(JSON.parse(String(stdout))).toMatchObject({
      ok: true,
      result: { legacyCompatibility: { readOnly: false } }
    })
  })

  it('vouches only for the exact terminal its attachment carries', () => {
    const runtime = new OrcaRuntimeService()
    const terminal = { handle: WORKER, paneKey: WORKER_PANE, processIncarnation: `${PTY_ID}:inc-1` }
    const host = runtime.registerOrchestrationCompatibilitySshAttachment(TARGET, 'c-1', terminal)
    const evidence = { terminalHandle: WORKER, paneKey: WORKER_PANE, launchToken: 't', host }
    expect(runtime.verifyOrchestrationCompatibilityCaller(evidence)).toMatchObject({
      terminalHandle: WORKER,
      processIncarnation: `${PTY_ID}:inc-1`,
      hostScope: { kind: 'ssh', targetId: TARGET }
    })
    for (const forged of [
      { ...evidence, terminalHandle: 'term_other' },
      { ...evidence, paneKey: 'tab_x:55555555-5555-4555-8555-555555555555' },
      { ...evidence, host: { ...host, targetId: 'other-target' } },
      { ...evidence, host: { ...host, connectionIncarnation: 'c-2' } }
    ]) {
      expect(runtime.verifyOrchestrationCompatibilityCaller(forged)).toBeNull()
    }
    runtime.releaseOrchestrationCompatibilitySshAttachment(host.attachmentId)
    expect(runtime.verifyOrchestrationCompatibilityCaller(evidence)).toBeNull()
  })
})
