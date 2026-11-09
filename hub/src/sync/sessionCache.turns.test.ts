import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'

async function setup() {
    const store = new Store(':memory:')
    const events: SyncEvent[] = []
    const publisher = { emit: (event: SyncEvent) => { events.push(event) } } as unknown as EventPublisher
    const cache = new SessionCache(store, publisher)
    const session = (await cache.getOrCreateSession(
        'turns-' + Math.random().toString(36).slice(2, 8),
        { path: '/tmp/project', host: 'mac', flavor: 'claude' },
        null,
        'default'
    ))
    return { store, cache, session }
}

function turns(store: Store) {
    return store.turns.list('default', 0, Date.now() + 60_000)
}

describe('SessionCache turn recording', () => {
    it('records a turn from thinking on to thinking off', async () => {
        const { store, cache, session } = (await setup())
        try {
            await cache.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: false })
            expect((await turns(store))).toEqual([])

            await cache.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true })
            await cache.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true })
            expect((await turns(store))).toHaveLength(1)
            expect((await turns(store))[0]).toMatchObject({ trigger: 'agent', endedAt: null })

            await cache.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: false })
            expect((await turns(store))[0]).toMatchObject({ endReason: 'idle' })
            expect((await turns(store))[0]?.endedAt).not.toBeNull()
        } finally {
            await store.close()
        }
    })

    it('starts a turn when a prompt is queued through the hub', async () => {
        const { store, cache, session } = (await setup())
        try {
            await cache.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: false })
            const sentAt = Date.now() - 2_000
            await cache.markMessageQueued(session.id, Date.now(), sentAt)

            expect((await turns(store))).toHaveLength(1)
            expect((await turns(store))[0]).toMatchObject({ trigger: 'hub_prompt', startedAt: sentAt, endedAt: null })
            // The agent picking it up doesn't start another one.
            await cache.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true })
            expect((await turns(store))).toHaveLength(1)
        } finally {
            await store.close()
        }
    })

    it('ends the turn when the session ends', async () => {
        const { store, cache, session } = (await setup())
        try {
            await cache.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true })
            await cache.handleSessionEnd({ sid: session.id, time: Date.now() })
            expect((await turns(store))[0]).toMatchObject({ endReason: 'session_end' })
        } finally {
            await store.close()
        }
    })

    it('ends an expired turn at the last keepalive, not when it was noticed', async () => {
        const { store, cache, session } = (await setup())
        try {
            await cache.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true })
            const lastKeepalive = cache.getSession(session.id)!.activeAt
            await cache.expireInactive(lastKeepalive + 301_000)
            expect((await turns(store))[0]).toMatchObject({ endReason: 'expired', endedAt: lastKeepalive })
        } finally {
            await store.close()
        }
    })

    it('records thinking changes that arrive as patches', async () => {
        const { store, cache, session } = (await setup())
        try {
            await cache.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: false })
            expect((await cache.applySessionPatch(session.id, { thinking: true }))).toBe(true)
            expect((await turns(store))[0]).toMatchObject({ trigger: 'patch', endedAt: null })
            expect((await cache.applySessionPatch(session.id, { thinking: false }))).toBe(true)
            expect((await turns(store))[0]?.endedAt).not.toBeNull()
        } finally {
            await store.close()
        }
    })

    async function restart(store: Store): Promise<SessionCache> {
        const restarted = new SessionCache(store, { emit: () => {} } as unknown as EventPublisher)
        await restarted.closeTurnsLeftOpen()
        await restarted.reloadAll()
        return restarted
    }

    it('continues a turn a hub restart cut short, however long the agent was quiet before it', async () => {
        const { store, session } = (await setup())
        try {
            // A command ran for 30 minutes without a message, then the hub restarted.
            const startedAt = Date.now() - 30 * 60_000
            await store.turns.open(session.id, 'default', startedAt, 'agent')
            await store.messages.addMessage(session.id, { role: 'agent', content: { type: 'text', text: 'running tests' } }, undefined, null, startedAt + 60_000)

            const restarted = (await restart(store))
            await restarted.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true })
            expect((await turns(store))).toHaveLength(1)
            expect((await turns(store))[0]).toMatchObject({ startedAt, endedAt: null })
        } finally {
            await store.close()
        }
    })

    it('starts a new turn once the agent was seen idle after a restart', async () => {
        const { store, session } = (await setup())
        try {
            await store.turns.open(session.id, 'default', Date.now() - 60_000, 'agent')
            const restarted = (await restart(store))
            await restarted.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: false })
            await restarted.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true })

            expect((await turns(store))).toHaveLength(2)
            expect((await turns(store))[0]?.endReason).toBe('hub_restart')
            expect((await turns(store))[1]?.endedAt).toBeNull()
        } finally {
            await store.close()
        }
    })

    it('starts a new turn for a prompt sent after a restart', async () => {
        const { store, session } = (await setup())
        try {
            await store.turns.open(session.id, 'default', Date.now() - 60_000, 'agent')
            const restarted = (await restart(store))
            await restarted.markSessionActive(session.id)
            await restarted.markMessageQueued(session.id)

            expect((await turns(store))).toHaveLength(2)
            expect((await turns(store))[0]?.endReason).toBe('hub_restart')
            expect((await turns(store))[1]).toMatchObject({ trigger: 'hub_prompt', endedAt: null })
        } finally {
            await store.close()
        }
    })

    it('keeps a merged-away session\'s turns', async () => {
        const { store, cache, session } = (await setup())
        const replacement = (await cache.getOrCreateSession('turns-new', { path: '/tmp/project', host: 'mac', flavor: 'claude' }, null, 'default'))
        try {
            await cache.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true })
            await cache.handleSessionEnd({ sid: session.id, time: Date.now() })
            await cache.mergeSessions(session.id, replacement.id, 'default')
            expect((await turns(store)).map((turn) => turn.sessionId)).toEqual([replacement.id])
        } finally {
            await store.close()
        }
    })
})
