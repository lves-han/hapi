import { describe, expect, it, spyOn } from 'bun:test'
import { Store } from '../store'
import { SessionCache } from './sessionCache'
import type { EventPublisher } from './eventPublisher'

describe('asynchronous cache reads', () => {
    for (const change of ['versioned patch', 'delete and recreate'] as const) {
        it(`keeps a delayed database snapshot from undoing ${change}`, async () => {
            const store = new Store(':memory:')
            const cache = new SessionCache(store, { emit() {} } as unknown as EventPublisher)
            const session = await cache.getOrCreateSession('old', { path: '/old', host: 'test' }, null, 'default')
            const snapshot = (await store.sessions.getSession(session.id))!
            let release!: () => void
            let started!: () => void
            const gate = new Promise<void>(resolve => { release = resolve })
            const reading = new Promise<void>(resolve => { started = resolve })
            const spy = spyOn(store.sessions, 'getSession').mockImplementationOnce(async () => {
                started()
                await gate
                return snapshot
            })
            const refresh = cache.refreshSession(session.id)
            try {
                await reading
                if (change === 'versioned patch') {
                    const metadata = { path: '/new', host: 'test' }
                    await store.sessions.updateSessionMetadata(session.id, metadata, 1, 'default')
                    cache.applySessionPatch(session.id, { metadata: { value: metadata, version: 2 } }, 'default')
                } else {
                    await cache.deleteSession(session.id)
                    await store.sessions.getOrCreateSession('new', { path: '/private', host: 'test' }, null, 'other', undefined, undefined, undefined, session.id)
                }
                release()
                await refresh
                if (change === 'versioned patch') {
                    expect(cache.getSession(session.id)?.metadataVersion).toBe(2)
                    expect(cache.getSession(session.id)?.metadata?.path).toBe('/new')
                } else {
                    expect(cache.getSessionByNamespace(session.id, 'default')).toBeUndefined()
                    expect(cache.getSession(session.id)?.namespace).toBe('other')
                }
            } finally {
                release()
                await refresh.catch(() => undefined)
                spy.mockRestore()
                await store.close()
            }
        })
    }
})
