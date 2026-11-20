import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import type { EventPublisher } from './eventPublisher'
import { MachineCache } from './machineCache'
import { SessionCache } from './sessionCache'
import { SyncEngine } from './syncEngine'

function createPublisher(events: SyncEvent[]): EventPublisher {
    return {
        emit: (event: SyncEvent) => {
            events.push(event)
        }
    } as unknown as EventPublisher
}

describe('alive incremental events', () => {
    it('replays durable immediate prompts on every attach until consumed', async () => {
        const store = new Store(':memory:')
        const emitted: Array<{ body?: { t?: string; message?: { localId?: string | null } } }> = []
        const io = {
            of: () => ({
                to: () => ({ emit: (_event: string, payload: unknown) => emitted.push(payload as typeof emitted[number]) })
            })
        }
        const engine = await SyncEngine.create(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const session = await engine.getOrCreateSession('attach-replay', { path: '/tmp/project', host: 'localhost' }, null, 'default')
            const userText = (text: string) => ({ role: 'user' as const, content: { type: 'text' as const, text } })
            await store.messages.addMessage(session.id, userText('queued before attach'), 'queued-before-attach')
            const invoked = await store.messages.addMessage(session.id, userText('already consumed'), 'already-consumed')
            await store.messages.markMessagesInvoked(session.id, ['already-consumed'], invoked.createdAt + 1)
            await store.messages.addMessage(session.id, userText('future scheduled'), 'future-scheduled', Date.now() + 60_000)
            expect(emitted).toEqual([])

            await engine.handleSessionAlive({ sid: session.id, time: Date.now() })
            await engine.handleSessionAlive({ sid: session.id, time: Date.now() + 1 })
            expect(emitted.map((update) => update.body?.message?.localId)).toEqual([
                'queued-before-attach', 'queued-before-attach'
            ])

            await store.messages.markMessagesInvoked(session.id, ['queued-before-attach'], Date.now())
            await engine.handleSessionAlive({ sid: session.id, time: Date.now() + 2 })
            expect(emitted.map((update) => update.body?.message?.localId)).toEqual([
                'queued-before-attach', 'queued-before-attach'
            ])
        } finally { await engine.stop() }
    })

    it('includes active=true in session alive updates', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = (await cache.getOrCreateSession(
            'session-alive-test',
            { path: '/tmp/project', host: 'localhost' },
            { requests: {}, completedRequests: {} },
            'default'
        ))

        events.length = 0
        await cache.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: false })

        const update = events.find((event) => event.type === 'session-updated')
        expect(update).toBeDefined()
        if (!update || update.type !== 'session-updated') {
            return
        }

        expect(update.data).toEqual(expect.objectContaining({ active: true }))
    })

    it('emits full active machine object on machine alive', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new MachineCache(store, createPublisher(events))

        const machine = (await cache.getOrCreateMachine(
            'machine-alive-test',
            { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
            null,
            'default'
        ))

        events.length = 0
        await cache.handleMachineAlive({ machineId: machine.id, time: Date.now() })

        const update = events.find((event) => event.type === 'machine-updated')
        expect(update).toBeDefined()
        if (!update || update.type !== 'machine-updated') {
            return
        }

        expect(update.data).toEqual(expect.objectContaining({ id: machine.id, active: true }))
    })

    it('stores health from machine alive and rebroadcasts when it changes', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new MachineCache(store, createPublisher(events))

        const machine = (await cache.getOrCreateMachine(
            'machine-health-test',
            { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
            null,
            'default'
        ))

        events.length = 0
        await cache.handleMachineAlive({
            machineId: machine.id,
            time: Date.now(),
            health: {
                collectedAt: Date.now(),
                load1m: 0.4,
                cpuCount: 8,
                memoryPercent: 55
            }
        })

        const updated = cache.getMachine(machine.id)
        expect(updated?.health).toEqual(expect.objectContaining({ load1m: 0.4, cpuCount: 8 }))

        events.length = 0
        await cache.handleMachineAlive({
            machineId: machine.id,
            time: Date.now() + 1,
            health: {
                collectedAt: Date.now() + 1,
                load1m: 2.1,
                cpuCount: 8,
                memoryPercent: 80
            }
        })

        const healthUpdate = events.find((event) => event.type === 'machine-updated')
        expect(healthUpdate).toBeDefined()
        if (!healthUpdate || healthUpdate.type !== 'machine-updated' || !healthUpdate.data || typeof healthUpdate.data !== 'object') {
            return
        }
        expect(healthUpdate.data).toEqual(expect.objectContaining({
            health: expect.objectContaining({ load1m: 2.1, memoryPercent: 80 })
        }))
    })

    it('marks session thinking immediately when a user message is accepted by the hub', async () => {
        const store = new Store(':memory:')
        const emittedSocketUpdates: unknown[] = []
        const io = {
            of: () => ({
                to: () => ({
                    emit: (_event: string, payload: unknown) => {
                        emittedSocketUpdates.push(payload)
                    }
                })
            })
        }
        const engine = await SyncEngine.create(
            store,
            io as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )
        const events: SyncEvent[] = []
        const unsubscribe = engine.subscribe((event) => {
            events.push(event)
        })

        try {
            const session = (await engine.getOrCreateSession(
                'session-send-thinking',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                { requests: {}, completedRequests: {} },
                'default'
            ))

            await engine.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: false })
            const activeAtBeforeSend = (await engine.getSession(session.id))?.activeAt
            events.length = 0

            await engine.sendMessage(session.id, {
                text: 'hello from web',
                sentFrom: 'webapp'
            })

            expect((await engine.getSession(session.id))?.thinking).toBe(true)
            expect((await engine.getSession(session.id))?.activeAt).toBe(activeAtBeforeSend)
            expect(emittedSocketUpdates.length).toBeGreaterThan(0)

            const received = events.find((event) => event.type === 'message-received')
            expect(received).toBeDefined()
            if (!received || received.type !== 'message-received') {
                return
            }
            expect((await engine.getSession(session.id))?.activeTurnStartedAt).toBe(received.message.createdAt)

            // Prefer the incremental markMessageQueued patch. A full session
            // snapshot (or a by-reference refreshSession emit later mutated in
            // place) can also show thinking=true and includes activeAt as a
            // snapshot field — that is not a claim that queued-thinking
            // refreshed liveness (asserted via activeAtBeforeSend above).
            const update = events.find((event) => {
                if (event.type !== 'session-updated' || typeof event.data !== 'object' || event.data === null) {
                    return false
                }
                const data = event.data as Record<string, unknown>
                return data.thinking === true
                    && 'activeTurnStartedAt' in data
                    && 'updatedAt' in data
                    && !('id' in data)
            })
            expect(update).toBeDefined()
            if (!update || update.type !== 'session-updated') {
                return
            }

            expect(update.data).toEqual(expect.objectContaining({ thinking: true }))
            expect(update.data).toEqual(expect.objectContaining({
                activeTurnStartedAt: expect.any(Number)
            }))
            expect(update.data).not.toHaveProperty('activeAt')
            expect((update.data as { updatedAt?: unknown }).updatedAt).toEqual(expect.any(Number))
        } finally {
            unsubscribe()
            await engine.stop()
        }
    })

    it('does not revive inactive sessions or refresh liveness when marking queued thinking', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const now = Date.now() - 30_000

        const session = (await cache.getOrCreateSession(
            'session-queued-thinking-inactive',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            { requests: {}, completedRequests: {} },
            'default'
        ))

        await cache.handleSessionAlive({ sid: session.id, time: now, thinking: false })
        await cache.handleSessionEnd({ sid: session.id, time: now + 1_000 })
        const inactive = cache.getSession(session.id)
        expect(inactive?.active).toBe(false)
        const inactiveActiveAt = inactive?.activeAt

        events.length = 0
        await cache.markMessageQueued(session.id, now + 2_000)

        const updated = cache.getSession(session.id)
        expect(updated?.active).toBe(false)
        expect(updated?.thinking).toBe(false)
        expect(updated?.activeAt).toBe(inactiveActiveAt)
        expect(events.find((event) => event.type === 'session-updated')).toBeUndefined()
    })

    it('starts a fresh grace window when an old local message is retried', async () => {
        const store = new Store(':memory:')
        const io = {
            of: () => ({
                to: () => ({ emit() {} })
            })
        }
        const engine = await SyncEngine.create(
            store,
            io as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )
        const now = Date.now()
        const originalNow = Date.now

        try {
            const session = (await engine.getOrCreateSession(
                'session-retry-thinking-grace',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                { requests: {}, completedRequests: {} },
                'default'
            ))

            Date.now = () => now - 20_000
            await engine.handleSessionAlive({ sid: session.id, time: now - 20_000, thinking: false })
            await engine.sendMessage(session.id, { text: 'retry me', localId: 'stable-local-id' })
            const storedTurnStartedAt = (await engine.getSession(session.id))?.activeTurnStartedAt

            Date.now = () => now
            await engine.handleSessionAlive({ sid: session.id, time: now, thinking: false })
            expect((await engine.getSession(session.id))?.thinking).toBe(false)

            await engine.sendMessage(session.id, { text: 'retry me', localId: 'stable-local-id' })
            expect((await engine.getSession(session.id))?.activeTurnStartedAt).toBe(storedTurnStartedAt)

            Date.now = () => now + 1_000
            await engine.handleSessionAlive({ sid: session.id, time: now + 1_000, thinking: false })
            expect((await engine.getSession(session.id))?.thinking).toBe(true)
        } finally {
            Date.now = originalNow
            await engine.stop()
        }
    })

    it('keeps the active boundary after consumption before the first true heartbeat', async () => {
        const store = new Store(':memory:')
        const io = {
            of: () => ({
                to: () => ({ emit() {} })
            })
        }
        const engine = await SyncEngine.create(
            store,
            io as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )
        const now = Date.now()

        try {
            const session = (await engine.getOrCreateSession(
                'session-consumed-before-thinking',
                { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                { requests: {}, completedRequests: {} },
                'default'
            ))
            await engine.handleSessionAlive({ sid: session.id, time: now, thinking: false })
            await engine.sendMessage(session.id, {
                text: 'consume before thinking',
                localId: 'consumed-local-id'
            })
            const activeTurnStartedAt = (await engine.getSession(session.id))?.activeTurnStartedAt
            await store.messages.markMessagesInvoked(session.id, ['consumed-local-id'], now + 500)

            await engine.handleSessionAlive({ sid: session.id, time: now + 1_000, thinking: false })

            expect((await engine.getSession(session.id))?.thinking).toBe(true)
            expect((await engine.getSession(session.id))?.activeTurnStartedAt).toBe(activeTurnStartedAt)
        } finally {
            await engine.stop()
        }
    })

    it('advances the queued turn boundary on the hub clock across a lagging false heartbeat', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const now = Date.now() - 30_000

        const session = (await cache.getOrCreateSession(
            'session-queued-thinking-grace',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            { requests: {}, completedRequests: {} },
            'default'
        ))

        await cache.handleSessionAlive({ sid: session.id, time: now, thinking: false })
        await store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'queued next prompt' } },
            'queued-next-local-id'
        )
        await cache.markMessageQueued(session.id, now + 10)
        const turnStartedAt = cache.getSession(session.id)?.activeTurnStartedAt
        events.length = 0

        const originalNow = Date.now
        Date.now = () => now + 2_000
        try {
            await cache.handleSessionAlive({ sid: session.id, time: now - 3_000, thinking: false })
        } finally {
            Date.now = originalNow
        }

        expect(cache.getSession(session.id)?.thinking).toBe(true)
        expect(cache.getSession(session.id)?.activeTurnStartedAt).not.toBe(turnStartedAt)
        expect(cache.getSession(session.id)?.activeTurnStartedAt).toBe(now + 2_000)
        const update = events.find((event) => event.type === 'session-updated')
        expect(update).toBeDefined()
        if (!update || update.type !== 'session-updated') return
        expect(update.data).toEqual(expect.objectContaining({
            thinking: true,
            activeTurnStartedAt: now + 2_000
        }))
    })

    it('clears queued thinking after the grace window expires', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const now = Date.now() - 30_000

        const session = (await cache.getOrCreateSession(
            'session-queued-thinking-expire',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            { requests: {}, completedRequests: {} },
            'default'
        ))

        await cache.handleSessionAlive({ sid: session.id, time: now, thinking: false })
        await cache.markMessageQueued(session.id, now + 10)
        events.length = 0

        await cache.handleSessionAlive({ sid: session.id, time: now + 16_000, thinking: false })

        expect(cache.getSession(session.id)?.thinking).toBe(false)
        const update = events.find((event) => event.type === 'session-updated')
        expect(update).toBeDefined()
        if (!update || update.type !== 'session-updated') {
            return
        }
        expect(update.data).toEqual(expect.objectContaining({ thinking: false }))
    })

    it('expires queued thinking against hub time instead of client heartbeat time', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const now = Date.now()

        const session = (await cache.getOrCreateSession(
            'session-queued-thinking-clock-skew',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            { requests: {}, completedRequests: {} },
            'default'
        ))

        await cache.handleSessionAlive({ sid: session.id, time: now, thinking: false })
        await cache.markMessageQueued(session.id, now + 10)
        events.length = 0

        const originalNow = Date.now
        Date.now = () => now + 16_000
        try {
            await cache.handleSessionAlive({ sid: session.id, time: now - 60_000, thinking: false })
        } finally {
            Date.now = originalNow
        }

        expect(cache.getSession(session.id)?.thinking).toBe(false)
        const update = events.find((event) => event.type === 'session-updated')
        expect(update).toBeDefined()
        if (!update || update.type !== 'session-updated') {
            return
        }
        expect(update.data).toEqual(expect.objectContaining({ thinking: false }))
    })

    it('judges liveness by hub receive time when the client clock lags (#1986)', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const machines = new MachineCache(store, createPublisher(events))
        const sessions = new SessionCache(store, createPublisher(events))
        const machine = (await machines.getOrCreateMachine(
            'machine-clock-skew',
            { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
            null,
            'default'
        ))
        const session = (await sessions.getOrCreateSession(
            'session-clock-skew',
            { path: '/tmp/project', host: 'localhost' },
            { requests: {}, completedRequests: {} },
            'default'
        ))
        const heartbeatAt = Date.now() + 60_000
        const laggingClientTime = heartbeatAt - 41_800

        const originalNow = Date.now
        Date.now = () => heartbeatAt
        try {
            await machines.handleMachineAlive({ machineId: machine.id, time: laggingClientTime })
            await sessions.handleSessionAlive({ sid: session.id, time: laggingClientTime, thinking: false })
        } finally {
            Date.now = originalNow
        }
        await machines.expireInactive(heartbeatAt + 5_000)
        await sessions.expireInactive(heartbeatAt + 5_000)

        expect(machines.getMachine(machine.id)?.active).toBe(true)
        expect(sessions.getSession(session.id)?.active).toBe(true)
    })

    it('throttles unchanged idle alive SSE broadcasts to 60s while emitting state changes immediately', async () => {
        const store = new Store(':memory:')
        const sessionEvents: SyncEvent[] = []
        const machineEvents: SyncEvent[] = []
        const sessions = new SessionCache(store, createPublisher(sessionEvents))
        const machines = new MachineCache(store, createPublisher(machineEvents))
        const t0 = 1_700_000_000_000
        let now = t0
        const originalNow = Date.now
        Date.now = () => now

        try {
            const session = await sessions.getOrCreateSession(
                'session-throttle-test',
                { path: '/tmp/project', host: 'localhost' },
                { requests: {}, completedRequests: {} },
                'default'
            )
            const machine = await machines.getOrCreateMachine(
                'machine-throttle-test',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )

            sessionEvents.length = 0
            machineEvents.length = 0
            await sessions.handleSessionAlive({ sid: session.id, time: now, thinking: false })
            await machines.handleMachineAlive({ machineId: machine.id, time: now })
            expect(sessionEvents.filter((event) => event.type === 'session-updated')).toHaveLength(1)
            expect(machineEvents.filter((event) => event.type === 'machine-updated')).toHaveLength(1)

            // Unchanged heartbeats within 60s must update liveness without spamming SSE.
            now = t0 + 30_000
            await sessions.handleSessionAlive({ sid: session.id, time: now, thinking: false })
            await machines.handleMachineAlive({ machineId: machine.id, time: now })
            expect(sessionEvents.filter((event) => event.type === 'session-updated')).toHaveLength(1)
            expect(machineEvents.filter((event) => event.type === 'machine-updated')).toHaveLength(1)

            // State changes within the 60s window still broadcast immediately.
            now = t0 + 35_000
            await sessions.handleSessionAlive({ sid: session.id, time: now, thinking: true })
            expect(sessionEvents.filter((event) => event.type === 'session-updated')).toHaveLength(2)

            // Past 60s without state changes, the periodic keep-alive SSE broadcast resumes.
            now = t0 + 96_000
            await sessions.handleSessionAlive({ sid: session.id, time: now, thinking: true })
            await machines.handleMachineAlive({ machineId: machine.id, time: now })
            expect(sessionEvents.filter((event) => event.type === 'session-updated')).toHaveLength(3)
            expect(machineEvents.filter((event) => event.type === 'machine-updated')).toHaveLength(2)
        } finally {
            Date.now = originalNow
            await store.close()
        }
    })
})
