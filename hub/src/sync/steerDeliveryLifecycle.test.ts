import { describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

async function createEngine(store = new Store(':memory:'), flavor: 'opencode' | 'claude' | 'codex' | 'cursor' = 'opencode') {
    const events: SyncEvent[] = []
    const io = { of: () => ({ to: () => ({ emit() {} }) }) }
    const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast(event: SyncEvent) { events.push(event) } } as never)
    const session = (await engine.getOrCreateSession('delivery-owner', { path: '/tmp/project', host: 'localhost', flavor, hostPid: 100, hostStartMarker: 'worker-A' }, { steeringActive: true }, 'default'))
    await engine.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true })
    for (const localId of ['pending', 'queued', 'consumed']) await store.messages.addMessage(session.id, { text: localId }, localId)
    await store.messages.setMessagesDeliveryState(session.id, ['pending'], 'dispatching')
    await store.messages.markMessagesInvoked(session.id, ['consumed'], 1000)
    return { store, engine, session, events }
}

async function expectUnknown(store: Store, engine: SyncEngine, sessionId: string) {
    expect((await engine.getQueuedState(sessionId, ['pending']))).toEqual({ queuedLocalIds: [], indeterminateLocalIds: ['pending'], invokedLocalMessages: [] })
    expect((await store.messages.lookupQueuedMessage(sessionId, 'pending')).status).toBe('indeterminate')
    expect((await store.messages.lookupQueuedMessage(sessionId, 'queued')).status).toBe('queued')
    expect((await store.messages.lookupQueuedMessage(sessionId, 'consumed')).status).toBe('invoked')
    expect((await store.messages.countMessages(sessionId))).toBe(3)
    expect((await engine.getDeliverableMessagesAfter(sessionId, { afterSeq: 0, limit: 100, now: Date.now() })).map(message => message.localId)).not.toContain('pending')
}

describe.each(['opencode', 'claude'] as const)('%s pending delivery ownership', (flavor) => {
    it('holds only unconfirmed dispatches as unknown when the session ends', async () => {
        const { store, engine, session, events } = (await createEngine(new Store(':memory:'), flavor))
        const other = (await store.sessions.getOrCreateSession('other', { path: '/tmp/other', flavor: 'opencode' }, null, 'other-namespace'))
        await store.messages.addMessage(other.id, { text: 'other' }, 'pending')
        await store.messages.setMessagesDeliveryState(other.id, ['pending'], 'dispatching')
        try {
            await engine.handleSessionEnd({ sid: session.id, time: Date.now(), reason: 'error' })
            await expectUnknown(store, engine, session.id)
            expect((await store.messages.lookupQueuedMessage(other.id, 'pending')).status).toBe('dispatching')
            expect(events).toContainEqual(expect.objectContaining({ type: 'messages-indeterminate', sessionId: session.id, localIds: ['pending'] }))
        } finally { await engine.stop(); await store.close() }
    })

    it('turns abandoned dispatches unknown when a replacement worker identifies itself after hub restart', async () => {
        const path = join(mkdtempSync(join(tmpdir(), 'hapi-steer-restart-')), 'hapi.db')
        const { store, engine, session } = (await createEngine(new Store(path), flavor))
        const id = session.id
        await engine.stop(); await store.close()
        const reopened = new Store(path)
        const io = { of: () => ({ to: () => ({ emit() {} }) }) }
        const restarted = await SyncEngine.create(reopened, io as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const before = (await reopened.sessions.getSession(id))!
            const metadata = { ...(before.metadata as Record<string, unknown>), hostPid: 101, hostStartMarker: 'worker-B' }
            const update = (await reopened.sessions.updateSessionMetadata(id, metadata, before.metadataVersion, 'default'))
            if (update.result !== 'success') throw new Error('metadata update failed')
            await restarted.handleRealtimeEvent({ type: 'session-updated', sessionId: id, data: { metadata: { version: update.version, value: metadata as never } } })
            await restarted.handleSessionAlive({ sid: id, time: Date.now(), thinking: true })
            expect((await restarted.getSession(id))?.thinking).toBe(true)
            await expectUnknown(reopened, restarted, id)
            const next = (await reopened.sessions.updateSessionAgentState(id, { steeringActive: true }, before.agentStateVersion, 'default'))
            if (next.result !== 'success') throw new Error('next state update failed')
            await restarted.handleRealtimeEvent({ type: 'session-updated', sessionId: id, data: { agentState: { version: next.version, value: { steeringActive: true } } } })
            await expectUnknown(reopened, restarted, id)
            await reopened.messages.markMessagesInvoked(id, ['pending'], 2000)
            expect((await restarted.getQueuedState(id, ['pending'])).invokedLocalMessages).toEqual([{ localId: 'pending', invokedAt: 2000 }])
        } finally { await restarted.stop(); await reopened.close() }
    })

    it('keeps pending delivery during a live reconnect but resolves an expired owner to unknown', async () => {
        const { store, engine, session } = (await createEngine(new Store(':memory:'), flavor))
        const clock = spyOn(Date, 'now')
        try {
            await engine.handleRealtimeEvent({ type: 'session-updated', sessionId: session.id })
            expect((await engine.getQueuedState(session.id, ['pending'])).dispatchingLocalIds).toEqual(['pending'])
            clock.mockReturnValue(session.activeAt + 300_001)
            await engine['expireInactive']()
            await expectUnknown(store, engine, session.id)
        } finally { clock.mockRestore(); await engine.stop(); await store.close() }
    })
})


it('does not confuse closing Steer admission with a live request finishing its drain', async () => {
    const { store, engine, session } = (await createEngine())
    try {
        const state = (await store.sessions.updateSessionAgentState(session.id, { steeringActive: false }, session.agentStateVersion, 'default'))
        if (state.result !== 'success') throw new Error('state update failed')
        await engine.handleRealtimeEvent({ type: 'session-updated', sessionId: session.id, data: { agentState: { version: state.version, value: { steeringActive: false } } } })
        expect((await engine.getQueuedState(session.id, ['pending'])).dispatchingLocalIds).toEqual(['pending'])
        expect((await store.messages.lookupQueuedMessage(session.id, 'pending')).status).toBe('dispatching')
    } finally { await engine.stop(); await store.close() }
})


it.each(['codex', 'cursor'] as const)('preserves the separate %s runtime delivery owner on metadata replacement', async (flavor) => {
    const { store, engine, session } = (await createEngine(new Store(':memory:'), flavor))
    try {
        // createEngine's returned session object can lag the DB: handleSessionAlive
        // may bump metadata (e.g. titleSuggestionTurn) and refresh the cache to a
        // new object while this local binding still holds the pre-alive version.
        const current = (await engine.getSession(session.id))!
        const metadata = { ...current.metadata!, hostPid: 101, hostStartMarker: 'worker-B' }
        const update = (await store.sessions.updateSessionMetadata(session.id, metadata, current.metadataVersion, 'default'))
        if (update.result !== 'success') throw new Error('metadata update failed')
        await engine.handleRealtimeEvent({ type: 'session-updated', sessionId: session.id, data: { metadata: { version: update.version, value: metadata } } })
        expect((await engine.getQueuedState(session.id, ['pending'])).dispatchingLocalIds).toEqual(['pending'])
        expect((await store.messages.lookupQueuedMessage(session.id, 'pending')).status).toBe('dispatching')
    } finally { await engine.stop(); await store.close() }
})
