import { describe, expect, it } from 'bun:test'
import { Store } from './index'

describe('session job terminal wake claim (#1489)', () => {
    it('fresh DB has wake columns (v34)', async () => {
        const store = new Store(':memory:')
        const cols = (store as unknown as { db: { prepare: (sql: string) => { all: () => Array<{ name: string }> } } })
            .db.prepare('PRAGMA table_info(session_jobs)').all().map((r) => r.name)
        expect(cols).toContain('wake_on_terminal')
        expect(cols).toContain('wake_prompt')
        expect(cols).toContain('wake_emitted_run_id')
        await store.close()
    })

    it('claims wake once per runId on terminal + opt-in', async () => {
        const store = new Store(':memory:')
        const session = await store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')

        const created = await store.sessionJobs.upsert(session.id, 'beets', {
            label: 'beets import',
            status: 'running',
            runId: 'run-a',
            wakeOnTerminal: true,
            wakePrompt: 'Next batch please.',
            detail: 'album: 1',
        })
        expect(created.outcome).toBe('upserted')

        expect((await store.sessionJobs.claimTerminalWake(session.id, 'beets'))).toBeNull()

        const patched = await store.sessionJobs.patch(session.id, 'beets', {
            status: 'completed',
            expectedRunId: 'run-a',
            detail: 'album: done',
        })
        expect(patched.outcome).toBe('patched')

        const first = await store.sessionJobs.claimTerminalWake(session.id, 'beets')
        expect(first).not.toBeNull()
        expect(first?.wakeEmittedRunId).toBe('pending:run-a')
        expect(first?.wakePrompt).toBe('Next batch please.')

        const second = await store.sessionJobs.claimTerminalWake(session.id, 'beets')
        expect(second).toBeNull()

        expect((await store.sessionJobs.markTerminalWakeDelivered(session.id, 'beets', 'run-a'))).toBe(true)
        expect((await store.sessionJobs.get(session.id, 'beets'))?.wakeEmittedRunId).toBe('run-a')
        expect((await store.sessionJobs.claimTerminalWake(session.id, 'beets'))).toBeNull()

        // Key reuse with a new run can wake again.
        await store.sessionJobs.upsert(session.id, 'beets', {
            label: 'beets import',
            status: 'running',
            runId: 'run-b',
            wakeOnTerminal: true,
        })
        await store.sessionJobs.patch(session.id, 'beets', {
            status: 'failed',
            expectedRunId: 'run-b',
        })
        const third = await store.sessionJobs.claimTerminalWake(session.id, 'beets')
        expect(third?.wakeEmittedRunId).toBe('pending:run-b')
        expect(third?.status).toBe('failed')

        await store.close()
    })

    it('does not claim when wakeOnTerminal is off', async () => {
        const store = new Store(':memory:')
        const session = await store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')
        await store.sessionJobs.upsert(session.id, 'x', {
            label: 'x',
            status: 'completed',
            runId: 'r1',
            wakeOnTerminal: false,
        })
        expect((await store.sessionJobs.claimTerminalWake(session.id, 'x'))).toBeNull()
        await store.close()
    })

    it('release clears provisional claim so delivery can retry', async () => {
        const store = new Store(':memory:')
        const session = await store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')
        await store.sessionJobs.upsert(session.id, 'beets', {
            label: 'beets',
            status: 'completed',
            runId: 'run-retry',
            wakeOnTerminal: true,
        })
        const claimed = await store.sessionJobs.claimTerminalWake(session.id, 'beets')
        expect(claimed?.wakeEmittedRunId).toBe('pending:run-retry')
        expect((await store.sessionJobs.claimTerminalWake(session.id, 'beets'))).toBeNull()

        expect((await store.sessionJobs.releaseTerminalWake(session.id, 'beets', 'run-retry'))).toBe(true)
        expect((await store.sessionJobs.get(session.id, 'beets'))?.wakeEmittedRunId).toBeUndefined()

        const reclaimed = await store.sessionJobs.claimTerminalWake(session.id, 'beets')
        expect(reclaimed?.wakeEmittedRunId).toBe('pending:run-retry')

        // Stale release id must not wipe a newer claim.
        expect((await store.sessionJobs.releaseTerminalWake(session.id, 'beets', 'run-other'))).toBe(false)
        expect((await store.sessionJobs.get(session.id, 'beets'))?.wakeEmittedRunId).toBe('pending:run-retry')
        await store.close()
    })

    it('clearAbandoned recovers provisional claims after hub restart', async () => {
        const store = new Store(':memory:')
        const session = await store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')
        await store.sessionJobs.upsert(session.id, 'beets', {
            label: 'beets',
            status: 'completed',
            runId: 'run-restart',
            wakeOnTerminal: true,
        })
        await store.sessionJobs.claimTerminalWake(session.id, 'beets')
        expect((await store.sessionJobs.get(session.id, 'beets'))?.wakeEmittedRunId).toBe('pending:run-restart')
        expect((await store.sessionJobs.claimTerminalWake(session.id, 'beets'))).toBeNull()

        expect((await store.sessionJobs.clearAbandonedProvisionalWakeClaims())).toBe(1)
        expect((await store.sessionJobs.get(session.id, 'beets'))?.wakeEmittedRunId).toBeUndefined()
        const reclaimed = await store.sessionJobs.claimTerminalWake(session.id, 'beets')
        expect(reclaimed?.wakeEmittedRunId).toBe('pending:run-restart')

        await store.sessionJobs.markTerminalWakeDelivered(session.id, 'beets', 'run-restart')
        expect((await store.sessionJobs.clearAbandonedProvisionalWakeClaims())).toBe(0)
        expect((await store.sessionJobs.get(session.id, 'beets'))?.wakeEmittedRunId).toBe('run-restart')
        await store.close()
    })

    it('lists pending terminal wakes when claim is absent or provisional', async () => {
        const store = new Store(':memory:')
        const session = await store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')
        await store.sessionJobs.upsert(session.id, 'open', {
            label: 'open',
            status: 'completed',
            runId: 'run-p',
            wakeOnTerminal: true,
        })
        await store.sessionJobs.upsert(session.id, 'inflight', {
            label: 'inflight',
            status: 'completed',
            runId: 'run-i',
            wakeOnTerminal: true,
        })
        await store.sessionJobs.claimTerminalWake(session.id, 'inflight')
        await store.sessionJobs.upsert(session.id, 'done', {
            label: 'done',
            status: 'completed',
            runId: 'run-d',
            wakeOnTerminal: true,
        })
        await store.sessionJobs.claimTerminalWake(session.id, 'done')
        await store.sessionJobs.markTerminalWakeDelivered(session.id, 'done', 'run-d')
        await store.sessionJobs.upsert(session.id, 'off', {
            label: 'off',
            status: 'completed',
            runId: 'run-o',
            wakeOnTerminal: false,
        })

        const pending = await store.sessionJobs.listPendingTerminalWakes()
        expect(pending.map((j) => j.key).sort()).toEqual(['inflight', 'open'])
        await store.close()
    })
})
