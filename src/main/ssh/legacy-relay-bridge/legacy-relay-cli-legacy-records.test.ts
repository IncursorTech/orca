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
const COORDINATOR = 'term_legacy_coord'
const COORDINATOR_PANE = 'tab_c:44444444-4444-4444-8444-444444444444'
const COORDINATOR_PTY = toAppSshPtyId(TARGET, 'pty-8')
const WORKER_ENV = {
  ORCA_TERMINAL_HANDLE: WORKER,
  ORCA_PANE_KEY: WORKER_PANE,
  ORCA_AGENT_LAUNCH_TOKEN: 'worker-token'
}

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
function legacyRuntime(): {
  runtime: OrcaRuntimeService
  database: OrchestrationDb
  taskId: string
  dispatchId: string
} {
  dir = mkdtempSync(join(tmpdir(), 'orca-legacy-relay-records-'))
  const path = join(dir, 'orchestration.db')
  const before = new OrchestrationDb(path)
  const task = before.createTask({
    runId: 'run_legacy_local',
    spec: 'legacy assignment',
    createdByTerminalHandle: COORDINATOR
  })
  const dispatch = createRootDispatch(before, task.id, WORKER, WORKER_PANE)
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
  return { runtime, database, taskId: task.id, dispatchId: dispatch.id }
}

function serverFor(runtime: OrcaRuntimeService) {
  const panes = new Map([
    [WORKER_PANE, { ptyId: PTY_ID, incarnationId: 'inc-1', terminalHandle: WORKER }],
    [COORDINATOR_PANE, { ptyId: COORDINATOR_PTY, incarnationId: 'inc-2' }]
  ])
  return createLegacyRelayCliServer({
    targetId: TARGET,
    runtime: () => runtime,
    remoteCliControl: () => true,
    livePane: (paneKey) => panes.get(paneKey) ?? null
  })
}

async function run(
  runtime: OrcaRuntimeService,
  argv: string[],
  env: Record<string, string> = WORKER_ENV
): Promise<{ exitCode: unknown; body: Record<string, unknown> }> {
  const result = await serverFor(runtime).cli({ argv, env }, new AbortController().signal)
  const fields = result && typeof result === 'object' ? result : {}
  const stdout = 'stdout' in fields ? String(fields.stdout) : '{}'
  return { exitCode: 'exitCode' in fields ? fields.exitCode : undefined, body: JSON.parse(stdout) }
}

describe('the relay-era orca CLI on migrated legacy orchestration records', () => {
  it('attests the bridge-verified worker instead of answering read-only', async () => {
    const { runtime, database } = legacyRuntime()
    expect(database.getLegacyAdoption()).toBeTruthy()
    const check = await run(runtime, ['orchestration', 'check', '--json'])
    expect(check.exitCode).toBe(0)
    expect(check.body).toMatchObject({
      ok: true,
      result: { legacyCompatibility: { readOnly: false } }
    })
  })

  it('admits the retained legacy coordinator and lets the worker report to it', async () => {
    const { runtime, taskId, dispatchId } = legacyRuntime()
    const coordinatorEnv = {
      ORCA_TERMINAL_HANDLE: COORDINATOR,
      ORCA_PANE_KEY: COORDINATOR_PANE,
      ORCA_AGENT_LAUNCH_TOKEN: 'coordinator-token'
    }
    const coordinatorCheck = await run(
      runtime,
      ['orchestration', 'check', '--json'],
      coordinatorEnv
    )
    expect(coordinatorCheck.body).toMatchObject({ ok: true })
    const escalation = await run(runtime, [
      'orchestration',
      'send',
      '--to',
      COORDINATOR,
      '--type',
      'escalation',
      '--subject',
      'blocked',
      '--task-id',
      taskId,
      '--dispatch-id',
      dispatchId,
      '--json'
    ])
    expect(escalation.body).toMatchObject({ ok: true })
  })

  it("replays a legacy worker's completed worker_done after it settled", async () => {
    const { runtime, database, taskId, dispatchId } = legacyRuntime()
    const done = [
      'orchestration',
      'send',
      '--to',
      COORDINATOR,
      '--type',
      'worker_done',
      '--subject',
      'done',
      '--task-id',
      taskId,
      '--dispatch-id',
      dispatchId,
      '--outcome',
      'succeeded',
      '--retry-request',
      '33333333-3333-4333-8333-333333333333',
      '--json'
    ]
    const first = await run(runtime, done)
    expect(first.body).toMatchObject({ ok: true })
    expect(database.getTask(taskId)?.status).toBe('completed')
    const replay = await run(runtime, done)
    expect(replay.body).toMatchObject({ ok: true })
    // A new assignment must not strand the settled one's retry.
    const next = database.createTask({
      runId: database.getLegacyAdoption()?.adopted_run_id ?? '',
      spec: 'next',
      createdByTerminalHandle: COORDINATOR
    })
    createRootDispatch(database, next.id, WORKER, WORKER_PANE)
    const afterReassignment = await run(runtime, done)
    expect(afterReassignment.body).toMatchObject({ ok: true })
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
