import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'
import { SyncEngine } from './syncEngine'

/**
 * A conversation keeps one reachable HAPI id: merges leave a durable redirect
 * from the merged-away id, and a resume by native Claude id (current or
 * rotated-away) finds the owning HAPI session.
 */

function createPublisher(): EventPublisher {
    return { emit: (_event: SyncEvent) => {} } as unknown as EventPublisher
}

function claudeMetadata(extra: Record<string, unknown> = {}) {
    return { path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'claude', ...extra }
}

describe('SessionRedirectStore', () => {
    it('path-compresses chains so every pointer targets the survivor', async () => {
        const store = new Store(':memory:')
        await store.sessionRedirects.record('a', 'b', 'ns', 1)
        await store.sessionRedirects.record('b', 'c', 'ns', 2)

        expect((await store.sessionRedirects.resolve('a', 'ns'))).toBe('c')
        expect((await store.sessionRedirects.resolve('b', 'ns'))).toBe('c')
        expect((await store.sessionRedirects.resolve('c', 'ns'))).toBeNull()
    })

    it('drops the stale pointer when a session is merged back into its old source', async () => {
        const store = new Store(':memory:')
        await store.sessionRedirects.record('a', 'b', 'ns')
        await store.sessionRedirects.record('b', 'a', 'ns')

        expect((await store.sessionRedirects.resolve('b', 'ns'))).toBe('a')
        expect((await store.sessionRedirects.resolve('a', 'ns'))).toBeNull()
    })

    it('is namespace-scoped', async () => {
        const store = new Store(':memory:')
        await store.sessionRedirects.record('a', 'b', 'ns-1')

        expect((await store.sessionRedirects.resolve('a', 'ns-2'))).toBeNull()
    })

    it('deleteTargeting removes pointers into a deleted session', async () => {
        const store = new Store(':memory:')
        await store.sessionRedirects.record('a', 'c', 'ns')
        await store.sessionRedirects.record('b', 'c', 'ns')
        await store.sessionRedirects.deleteTargeting('c', 'ns')

        expect((await store.sessionRedirects.resolve('a', 'ns'))).toBeNull()
        expect((await store.sessionRedirects.resolve('b', 'ns'))).toBeNull()
    })
})

describe('SessionCache merge keeps the merged-away id reachable', () => {
    async function setup() {
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher())
        const oldSession = await cache.getOrCreateSession('old', claudeMetadata({
            name: 'Guest↔host interaction channel design',
            claudeSessionId: 'claude-a',
            claudeSessionIdHistory: ['claude-0']
        }), null, 'default')
        const newSession = await cache.getOrCreateSession('new', claudeMetadata({
            claudeSessionId: 'claude-b'
        }), null, 'default')
        return { store, cache, oldSession, newSession }
    }

    it('resolves the old id to the surviving session after mergeSessions', async () => {
        const { cache, oldSession, newSession } = await setup()
        await cache.mergeSessions(oldSession.id, newSession.id, 'default')

        expect(cache.getSession(oldSession.id)).toBeUndefined()
        // Internal lookups stay strict; only the client boundary follows redirects.
        expect((await cache.resolveSessionAccess(oldSession.id, 'default'))).toEqual({ ok: false, reason: 'not-found' })
        const access = await cache.resolveSessionAccessFollowingRedirects(oldSession.id, 'default')
        expect(access.ok).toBe(true)
        if (access.ok) {
            expect(access.sessionId).toBe(newSession.id)
            expect(access.session.metadata?.name).toBe('Guest↔host interaction channel design')
        }
    })

    it('does not resolve the old id from another namespace', async () => {
        const { cache, oldSession, newSession } = await setup()
        await cache.mergeSessions(oldSession.id, newSession.id, 'default')

        expect((await cache.resolveSessionAccessFollowingRedirects(oldSession.id, 'other'))).toEqual({ ok: false, reason: 'not-found' })
    })

    it('carries the source Claude ids into the survivor history', async () => {
        const { cache, oldSession, newSession } = await setup()
        await cache.mergeSessions(oldSession.id, newSession.id, 'default')

        const survivor = cache.getSession(newSession.id)
        expect(survivor?.metadata?.claudeSessionId).toBe('claude-b')
        expect(survivor?.metadata?.claudeSessionIdHistory).toEqual(['claude-0', 'claude-a'])
    })

    it('stops resolving the old id once the survivor is deleted', async () => {
        const { cache, oldSession, newSession } = await setup()
        await cache.mergeSessions(oldSession.id, newSession.id, 'default')
        await cache.deleteSession(newSession.id)

        expect((await cache.resolveSessionAccessFollowingRedirects(oldSession.id, 'default'))).toEqual({ ok: false, reason: 'not-found' })
    })
})

describe('SyncEngine.resolveLocalResumeTargetByAgentSessionId', () => {
    async function setup() {
        const store = new Store(':memory:')
        const engine = await SyncEngine.create(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        return { store, engine }
    }

    it('returns the session whose current Claude id matches', async () => {
        const { engine } = await setup()
        try {
            const session = await engine.getOrCreateSession('current', claudeMetadata({
                claudeSessionId: 'claude-current'
            }), null, 'default')

            const result = await engine.resolveLocalResumeTargetByAgentSessionId('claude-current', 'default', { machineId: 'machine-1' })

            expect(result).toMatchObject({
                type: 'success',
                historical: false,
                target: { sessionId: session.id, flavor: 'claude', agentSessionId: 'claude-current' }
            })
        } finally {
            await engine.stop()
        }
    })

    it('finds the owner by a rotated-away Claude id and reports its current id', async () => {
        const { engine } = await setup()
        try {
            const session = await engine.getOrCreateSession('rotated', claudeMetadata({
                claudeSessionId: '7e6b91b1',
                claudeSessionIdHistory: ['2a9e1ab6']
            }), null, 'default')

            const result = await engine.resolveLocalResumeTargetByAgentSessionId('2a9e1ab6', 'default')

            expect(result).toMatchObject({
                type: 'success',
                historical: true,
                target: { sessionId: session.id, agentSessionId: '7e6b91b1' }
            })
        } finally {
            await engine.stop()
        }
    })

    it('returns no target when no Claude session owns the id', async () => {
        const { engine } = await setup()
        try {
            await engine.getOrCreateSession('codex', {
                path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'codex', codexSessionId: 'claude-x'
            }, null, 'default')

            expect((await engine.resolveLocalResumeTargetByAgentSessionId('claude-x', 'default')))
                .toEqual({ type: 'success', target: null, historical: false })
        } finally {
            await engine.stop()
        }
    })

    it('ignores sessions recorded on another machine and in another namespace', async () => {
        const { engine } = await setup()
        try {
            await engine.getOrCreateSession('other-machine', claudeMetadata({
                machineId: 'machine-2', claudeSessionId: 'claude-y'
            }), null, 'default')
            await engine.getOrCreateSession('other-namespace', claudeMetadata({
                claudeSessionId: 'claude-y'
            }), null, 'other')

            expect((await engine.resolveLocalResumeTargetByAgentSessionId('claude-y', 'default', { machineId: 'machine-1' })))
                .toEqual({ type: 'success', target: null, historical: false })
        } finally {
            await engine.stop()
        }
    })
})

describe('SyncEngine.prepareLocalResume', () => {
    async function setup() {
        const store = new Store(':memory:')
        const engine = await SyncEngine.create(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        return { store, engine }
    }

    it('clears a hub-authored archive so a terminal reopen is not refused', async () => {
        const { engine } = await setup()
        try {
            const session = await engine.getOrCreateSession('hub-archived', claudeMetadata({
                claudeSessionId: 'claude-h', lifecycleState: 'archived', archivedBy: 'hub', archiveReason: 'Archived by user'
            }), null, 'default')

            await expect(engine.prepareLocalResume(session.id, 'default')).resolves.toEqual({ type: 'success', revived: true })

            const metadata = (await engine.getSession(session.id))?.metadata
            expect(metadata?.lifecycleState).toBeUndefined()
            expect(metadata?.archivedBy).toBeUndefined()
            expect(metadata?.claudeSessionId).toBe('claude-h')
        } finally {
            await engine.stop()
        }
    })

    it('leaves CLI-archived and live-lifecycle rows alone', async () => {
        const { engine } = await setup()
        try {
            const cliArchived = await engine.getOrCreateSession('cli-archived', claudeMetadata({
                lifecycleState: 'archived', archivedBy: 'cli'
            }), null, 'default')

            await expect(engine.prepareLocalResume(cliArchived.id, 'default')).resolves.toEqual({ type: 'success', revived: false })
            expect((await engine.getSession(cliArchived.id))?.metadata?.archivedBy).toBe('cli')
        } finally {
            await engine.stop()
        }
    })

    it('refuses active sessions and unknown ids', async () => {
        const { engine } = await setup()
        try {
            const live = await engine.getOrCreateSession('live', claudeMetadata(), null, 'default')
            await engine.handleSessionAlive({ sid: live.id, time: Date.now() })

            await expect(engine.prepareLocalResume(live.id, 'default')).resolves.toMatchObject({ type: 'error', code: 'session_active' })
            await expect(engine.prepareLocalResume('missing', 'default')).resolves.toMatchObject({ type: 'error', code: 'session_not_found' })
        } finally {
            await engine.stop()
        }
    })
})
