import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'

function createPublisher(events: SyncEvent[]): EventPublisher {
    return {
        emit: (event: SyncEvent) => {
            events.push(event)
        }
    } as unknown as EventPublisher
}

const baseTime = 1_780_000_000_000

async function withMockedClock(run: (setTime: (value: number) => void) => Promise<void>): Promise<void> {
    const originalDateNow = Date.now
    let now = baseTime
    Date.now = () => now
    try {
        await run(value => { now = value })
    } finally {
        Date.now = originalDateNow
    }
}

async function createActiveSession(cache: SessionCache, id: string, thinking: boolean): Promise<string> {
    const session = (await cache.getOrCreateSession(
        id,
        { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
        null,
        'default'
    ))
    await cache.handleSessionAlive({
        sid: session.id,
        time: baseTime,
        thinking
    })
    return session.id
}

describe('expireInactive thinking grace', () => {
    it('keeps a thinking session active past the plain keepalive timeout', async () => {
        await withMockedClock(async (setTime) => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))
            const sessionId = (await createActiveSession(cache, 'session-thinking-grace-hold', true))
            events.length = 0

            const expired = (await cache.expireInactive(baseTime + 60_000))

            expect(expired).toEqual([])
            expect(cache.getSession(sessionId)?.active).toBe(true)
            expect(cache.getSession(sessionId)?.thinking).toBe(true)
            expect(events).toEqual([])
        })
    })

    it('expires a thinking session once the extended grace elapses', async () => {
        await withMockedClock(async (setTime) => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))
            const sessionId = (await createActiveSession(cache, 'session-thinking-grace-expire', true))
            events.length = 0

            const expired = (await cache.expireInactive(baseTime + 300_001))

            expect(expired).toEqual([sessionId])
            expect(cache.getSession(sessionId)?.active).toBe(false)
            expect(cache.getSession(sessionId)?.thinking).toBe(false)
            expect(events.some((event) => event.type === 'session-updated')).toBe(true)
        })
    })

    it('still expires an idle session on the plain keepalive timeout', async () => {
        await withMockedClock(async (setTime) => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))
            const sessionId = (await createActiveSession(cache, 'session-idle-timeout', false))

            expect((await cache.expireInactive(baseTime + 29_999))).toEqual([])
            expect((await cache.expireInactive(baseTime + 30_001))).toEqual([sessionId])
            expect(cache.getSession(sessionId)?.active).toBe(false)
        })
    })

    it('falls back to the plain timeout once a session stops thinking', async () => {
        await withMockedClock(async (setTime) => {
            const store = new Store(':memory:')
            const events: SyncEvent[] = []
            const cache = new SessionCache(store, createPublisher(events))
            const sessionId = (await createActiveSession(cache, 'session-thinking-then-idle', true))

            setTime(baseTime + 120_000)
            await cache.handleSessionAlive({
                sid: sessionId,
                time: baseTime + 120_000,
                thinking: false
            })

            expect((await cache.expireInactive(baseTime + 150_001))).toEqual([sessionId])
            expect(cache.getSession(sessionId)?.active).toBe(false)
        })
    })
})
