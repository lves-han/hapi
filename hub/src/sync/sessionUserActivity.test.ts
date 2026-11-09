import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol'
import { toSessionSummary } from '@hapi/protocol'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

describe('user-activity ordering SSE', () => {
    it('publishes a summary patch only when stored user input advances the clock', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast: (event: SyncEvent) => events.push(event) } as never)
        try {
            const session = (await engine.getOrCreateSession('tag', { path: '/tmp', host: 'mac' }, null, 'default'))
            const receive = async (content: unknown, at: number, localId?: string) => {
                const message = (await store.messages.addMessage(session.id, content, localId, null, at))
                await engine.handleRealtimeEvent({ type: 'message-received', sessionId: session.id, message })
            }
            const user = { role: 'user', content: { type: 'text', text: 'hello' } }
            await receive(user, 100, 'prompt')
            expect(toSessionSummary((await engine.getSession(session.id))!).lastUserMessageAt).toBe(100)
            expect(events.some(e => e.type === 'session-updated' && e.data && 'lastUserMessageAt' in e.data && e.data.lastUserMessageAt === 100)).toBe(true)
            events.length = 0
            await receive(user, 500, 'prompt')
            await receive({ role: 'agent', content: { type: 'text', text: 'working' } }, 900)
            await engine.recordSessionActivity(session.id, 1_000)
            expect(toSessionSummary((await engine.getSession(session.id))!).lastUserMessageAt).toBe(100)
            expect(events.filter(e => e.type === 'session-updated' && e.data && 'lastUserMessageAt' in e.data)).toHaveLength(0)
            await receive(user, 2_000, 'next')
            expect(toSessionSummary((await engine.getSession(session.id))!).lastUserMessageAt).toBe(2_000)
        } finally {
            await engine.stop()
            await store.close()
        }
    })
})
