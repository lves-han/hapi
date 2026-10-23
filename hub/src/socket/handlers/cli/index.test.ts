import { describe, expect, it, mock } from 'bun:test'
import { Store } from '../../../store'
import type { CliSocketWithData } from '../../socketTypes'
import { registerCliHandlers } from './index'

class FakeCliSocket {
    readonly handlers = new Map<string, (data: unknown, ack?: (response: unknown) => void) => unknown>()
    readonly emitted: Array<{ event: string; data: unknown }> = []
    readonly rooms: string[] = []
    data: { namespace?: string } = {}
    handshake = { auth: {} as Record<string, unknown> }

    on(event: string, handler: (data: unknown, ack?: (response: unknown) => void) => unknown): this {
        this.handlers.set(event, handler)
        return this
    }

    join(room: string): this {
        this.rooms.push(room)
        return this
    }

    emit(event: string, data: unknown): this {
        this.emitted.push({ event, data })
        return this
    }

    to(): { emit: (event: string, data: unknown) => void } {
        return { emit: () => {} }
    }

    async trigger(event: string, data: unknown, ack?: (response: unknown) => void): Promise<void> {
        await this.handlers.get(event)?.(data, ack)
    }
}

const anyRegistry = new Proxy({}, { get: () => () => {} }) as never
const fakeIo = { of: () => ({ to: () => ({ emit: () => {} }) }) } as never

describe('cli handler session-access memo', () => {
    it('keeps the first packet while initial room authorization is pending', async () => {
        const store = new Store(':memory:')
        const session = await store.sessions.getOrCreateSession('initial-packet', null, null, 'default')
        let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        const original = store.sessions.getSessionByNamespace.bind(store.sessions)
        store.sessions.getSessionByNamespace = async (...args) => {
            await gate
            return original(...args)
        }
        const socket = new FakeCliSocket()
        socket.data.namespace = 'default'
        socket.handshake.auth.sessionId = session.id
        const alive = mock(() => {
            expect(socket.rooms).toContain(`session:${session.id}`)
        })
        const registering = registerCliHandlers(socket as unknown as CliSocketWithData, {
            io: fakeIo, store, rpcRegistry: anyRegistry, terminalRegistry: anyRegistry,
            onSessionAlive: alive
        })
        const packet = socket.trigger('session-alive', { sid: session.id, time: Date.now() })
        expect(alive).toHaveBeenCalledTimes(0)
        release()
        await registering
        await packet
        expect(alive).toHaveBeenCalledTimes(1)
        await store.close()
    })

    it('serves repeated events for one session from the per-socket cache', async () => {
        const store = new Store(':memory:')
        const session = (await store.sessions.getOrCreateSession('memo-burst', null, null, 'default'))

        let byNamespaceCalls = 0
        const original = store.sessions.getSessionByNamespace.bind(store.sessions)
        store.sessions.getSessionByNamespace = (async (sessionId: string, namespace: string) => {
            byNamespaceCalls += 1
            return (await original(sessionId, namespace))
        }) as typeof store.sessions.getSessionByNamespace

        const socket = new FakeCliSocket()
        socket.data = { namespace: 'default' }
        const alive = mock()
        await registerCliHandlers(socket as unknown as CliSocketWithData, {
            io: fakeIo,
            store,
            rpcRegistry: anyRegistry,
            terminalRegistry: anyRegistry,
            onSessionAlive: alive
        })

        // Burst of events against the same session: one store read, many events.
        for (let i = 0; i < 5; i += 1) {
            await socket.trigger('session-alive', { sid: session.id, time: Date.now() })
        }
        expect(alive).toHaveBeenCalledTimes(5)
        expect(byNamespaceCalls).toBe(1)

        // A different session id misses the cache.
        await socket.trigger('session-alive', { sid: 'other-session', time: Date.now() })
        expect(byNamespaceCalls).toBe(2)
        await store.close()
    })

    it('does not cache denials — every denied event re-resolves', async () => {
        const store = new Store(':memory:')
        let plainCalls = 0
        const original = store.sessions.getSession.bind(store.sessions)
        store.sessions.getSession = (async (sessionId: string) => {
            plainCalls += 1
            return (await original(sessionId))
        }) as typeof store.sessions.getSession

        const socket = new FakeCliSocket()
        socket.data = { namespace: 'default' }
        await registerCliHandlers(socket as unknown as CliSocketWithData, {
            io: fakeIo,
            store,
            rpcRegistry: anyRegistry,
            terminalRegistry: anyRegistry
        })

        await socket.trigger('session-alive', { sid: 'missing', time: Date.now() })
        await socket.trigger('session-alive', { sid: 'missing', time: Date.now() })
        expect(plainCalls).toBe(2)
        expect(socket.emitted.filter(({ event }) => event === 'error')).toHaveLength(2)
        await store.close()
    })

    it('expires the memo after the TTL window', async () => {
        const store = new Store(':memory:')
        const session = (await store.sessions.getOrCreateSession('memo-ttl', null, null, 'default'))

        let byNamespaceCalls = 0
        const original = store.sessions.getSessionByNamespace.bind(store.sessions)
        store.sessions.getSessionByNamespace = (async (sessionId: string, namespace: string) => {
            byNamespaceCalls += 1
            return (await original(sessionId, namespace))
        }) as typeof store.sessions.getSessionByNamespace

        const socket = new FakeCliSocket()
        socket.data = { namespace: 'default' }
        await registerCliHandlers(socket as unknown as CliSocketWithData, {
            io: fakeIo,
            store,
            rpcRegistry: anyRegistry,
            terminalRegistry: anyRegistry
        })

        await socket.trigger('session-alive', { sid: session.id, time: Date.now() })
        expect(byNamespaceCalls).toBe(1)

        await new Promise((resolve) => setTimeout(resolve, 1100))
        await socket.trigger('session-alive', { sid: session.id, time: Date.now() })
        expect(byNamespaceCalls).toBe(2)
        await store.close()
    })

    it('keeps per-session entries under interleaved multi-session traffic (A-B-A)', async () => {
        const store = new Store(':memory:')
        const a = (await store.sessions.getOrCreateSession('memo-inter-a', null, null, 'default'))
        const b = (await store.sessions.getOrCreateSession('memo-inter-b', null, null, 'default'))

        let byNamespaceCalls = 0
        const original = store.sessions.getSessionByNamespace.bind(store.sessions)
        store.sessions.getSessionByNamespace = (async (sessionId: string, namespace: string) => {
            byNamespaceCalls += 1
            return (await original(sessionId, namespace))
        }) as typeof store.sessions.getSessionByNamespace

        const socket = new FakeCliSocket()
        socket.data = { namespace: 'default' }
        const alive = mock()
        await registerCliHandlers(socket as unknown as CliSocketWithData, {
            io: fakeIo,
            store,
            rpcRegistry: anyRegistry,
            terminalRegistry: anyRegistry,
            onSessionAlive: alive
        })

        // A-B-A interleave within the TTL: a single-slot memo thrashes to a
        // miss on every event here (one runner socket multiplexes concurrent
        // sessions); the per-session map must resolve each session once.
        await socket.trigger('session-alive', { sid: a.id, time: Date.now() })
        await socket.trigger('session-alive', { sid: b.id, time: Date.now() })
        await socket.trigger('session-alive', { sid: a.id, time: Date.now() })
        await socket.trigger('session-alive', { sid: b.id, time: Date.now() })
        await socket.trigger('session-alive', { sid: a.id, time: Date.now() })
        expect(byNamespaceCalls).toBe(2)
        expect(alive).toHaveBeenCalledTimes(5)
        await store.close()
    })

    it('bounds the cache across many sessions (oldest evicted first)', async () => {
        const store = new Store(':memory:')
        const ids: string[] = []
        for (let i = 0; i < 70; i += 1) {
            ids.push((await store.sessions.getOrCreateSession(`memo-many-${i}`, null, null, 'default')).id)
        }

        let byNamespaceCalls = 0
        const original = store.sessions.getSessionByNamespace.bind(store.sessions)
        store.sessions.getSessionByNamespace = (async (sessionId: string, namespace: string) => {
            byNamespaceCalls += 1
            return (await original(sessionId, namespace))
        }) as typeof store.sessions.getSessionByNamespace

        const socket = new FakeCliSocket()
        socket.data = { namespace: 'default' }
        await registerCliHandlers(socket as unknown as CliSocketWithData, {
            io: fakeIo,
            store,
            rpcRegistry: anyRegistry,
            terminalRegistry: anyRegistry
        })

        for (const id of ids) {
            await socket.trigger('session-alive', { sid: id, time: Date.now() })
        }
        const afterFirstPass = byNamespaceCalls

        // The newest entry is still cached.
        await socket.trigger('session-alive', { sid: ids[69], time: Date.now() })
        expect(byNamespaceCalls).toBe(afterFirstPass)

        // The oldest entries were evicted once the cache exceeded its cap.
        await socket.trigger('session-alive', { sid: ids[0], time: Date.now() })
        expect(byNamespaceCalls).toBe(afterFirstPass + 1)
        await store.close()
    })

    it('update-metadata resolves the session fresh so hub-owned fields survive a warm memo', async () => {
        const store = new Store(':memory:')
        const session = (await store.sessions.getOrCreateSession('memo-meta', null, null, 'default'))

        let byNamespaceCalls = 0
        const original = store.sessions.getSessionByNamespace.bind(store.sessions)
        store.sessions.getSessionByNamespace = (async (sessionId: string, namespace: string) => {
            byNamespaceCalls += 1
            return (await original(sessionId, namespace))
        }) as typeof store.sessions.getSessionByNamespace

        const socket = new FakeCliSocket()
        socket.data = { namespace: 'default' }
        await registerCliHandlers(socket as unknown as CliSocketWithData, {
            io: fakeIo,
            store,
            rpcRegistry: anyRegistry,
            terminalRegistry: anyRegistry
        })

        // Warm the memo with a metadata-less snapshot of the session.
        await socket.trigger('session-alive', { sid: session.id, time: Date.now() })
        expect(byNamespaceCalls).toBe(1)

        // A hub-side write lands the hub-owned key AFTER the memo was warmed.
        const hubWrite = (await store.sessions.updateSessionMetadata(
            session.id,
            { supersededBySessionId: 'successor' },
            session.metadataVersion,
            'default'
        ))
        expect(hubWrite.result).toBe('success')
        const live = (await store.sessions.getSession(session.id))
        expect(live).not.toBeNull()

        // The client's metadata write omits the hub-owned key. A stale memo
        // base (metadata: null) would strip it from the merged row; a fresh
        // resolve preserves it from the live row.
        let ack: unknown
        await socket.trigger('update-metadata', {
            sid: session.id,
            metadata: { title: 'renamed' },
            expectedVersion: live!.metadataVersion
        }, (response: unknown) => { ack = response })

        // The write path bypassed the memo (fresh resolve).
        expect(byNamespaceCalls).toBe(2)
        expect((ack as { result: string }).result).toBe('success')

        const stored = (await store.sessions.getSession(session.id))
        const metadata = stored!.metadata as Record<string, unknown>
        expect(metadata.title).toBe('renamed')
        expect(metadata.supersededBySessionId).toBe('successor')
        await store.close()
    })

    it('drops the memo as soon as the session is deleted (deletion epoch)', async () => {
        const store = new Store(':memory:')
        const session = (await store.sessions.getOrCreateSession('memo-del', null, null, 'default'))

        let byNamespaceCalls = 0
        const original = store.sessions.getSessionByNamespace.bind(store.sessions)
        store.sessions.getSessionByNamespace = (async (sessionId: string, namespace: string) => {
            byNamespaceCalls += 1
            return (await original(sessionId, namespace))
        }) as typeof store.sessions.getSessionByNamespace

        const socket = new FakeCliSocket()
        socket.data = { namespace: 'default' }
        await registerCliHandlers(socket as unknown as CliSocketWithData, {
            io: fakeIo,
            store,
            rpcRegistry: anyRegistry,
            terminalRegistry: anyRegistry
        })

        // Warm the memo.
        await socket.trigger('session-alive', { sid: session.id, time: Date.now() })
        expect(byNamespaceCalls).toBe(1)

        // Hub-side delete (webapp API, session merge — every path funnels
        // through the store's deleteSession).
        expect((await store.sessions.deleteSession(session.id, 'default'))).toBe(true)

        // Well inside the TTL, the next event must not be served from the
        // memo: the deletion bumped the epoch, forcing a fresh resolve that
        // denies instead of authorizing events against the deleted row.
        await socket.trigger('session-alive', { sid: session.id, time: Date.now() })
        expect(byNamespaceCalls).toBe(2)
        expect(socket.emitted.filter(({ event }) => event === 'error')).toHaveLength(1)
        await store.close()
    })

    it('native-queue-message reads live capabilities, not a memo snapshot', async () => {
        const store = new Store(':memory:')
        const session = (await store.sessions.getOrCreateSession('memo-queue', null, null, 'default'))

        let byNamespaceCalls = 0
        const original = store.sessions.getSessionByNamespace.bind(store.sessions)
        store.sessions.getSessionByNamespace = (async (sessionId: string, namespace: string) => {
            byNamespaceCalls += 1
            return (await original(sessionId, namespace))
        }) as typeof store.sessions.getSessionByNamespace

        const socket = new FakeCliSocket()
        socket.data = { namespace: 'default' }
        const onWebappEvent = mock()
        await registerCliHandlers(socket as unknown as CliSocketWithData, {
            io: fakeIo,
            store,
            rpcRegistry: anyRegistry,
            terminalRegistry: anyRegistry,
            onWebappEvent
        })

        // Warm the memo while the session has no capabilities.
        await socket.trigger('session-alive', { sid: session.id, time: Date.now() })
        expect(byNamespaceCalls).toBe(1)

        // Capabilities land via a metadata write (hub side, e.g. a merge
        // copying capabilities onto the session).
        const write = (await store.sessions.updateSessionMetadata(
            session.id,
            { capabilities: { concurrentClients: true } },
            session.metadataVersion,
            'default'
        ))
        expect(write.result).toBe('success')

        // Within the TTL a memo snapshot would still see capabilities as
        // absent and silently drop the queued entry; the fresh read
        // processes it.
        await socket.trigger('native-queue-message', { sid: session.id, localId: 'q1', text: 'queued hello' })
        expect(byNamespaceCalls).toBe(2)

        const received = onWebappEvent.mock.calls
            .map(([event]) => event as { type: string })
            .find((event) => event.type === 'message-received')
        expect(received).toBeDefined()
        await store.close()
    })
})
