import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol'
import { toSessionSummary } from '@hapi/protocol'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { createPromptTitle } from './promptTitle'
import type { SessionCache } from './sessionCache'
import { SyncEngine } from './syncEngine'

const userText = (text: string) => ({ role: 'user', content: { type: 'text', text } })

describe('createPromptTitle', () => {
    it('collapses whitespace and truncates long prompts', () => {
        expect(createPromptTitle(userText('  Fix the\n\nlogin   redirect  '))).toBe('Fix the login redirect')
        const title = createPromptTitle(userText('a'.repeat(100)))
        expect(title).toHaveLength(80)
        expect(title?.endsWith('…')).toBe(true)
    })

    it('ignores slash commands, empty prompts and agent output', () => {
        expect(createPromptTitle(userText('/compact'))).toBeNull()
        expect(createPromptTitle(userText('   '))).toBeNull()
        expect(createPromptTitle({ role: 'agent', content: { type: 'text', text: 'working' } })).toBeNull()
    })
})

describe('prompt title', () => {
    async function setup(metadata: Record<string, unknown> = {}) {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast: (event: SyncEvent) => events.push(event) } as never)
        const session = (await engine.getOrCreateSession('tag', { path: '/tmp/project', host: 'mac', ...metadata }, null, 'default'))
        const receive = async (content: unknown, localId?: string) => {
            const message = (await store.messages.addMessage(session.id, content, localId))
            await engine.handleRealtimeEvent({ type: 'message-received', sessionId: session.id, message })
        }
        return { store, events, engine, session, receive }
    }

    it('titles an untitled session from its first prompt without blocking generated titles', async () => {
        const { store, events, engine, session, receive } = (await setup())
        try {
            await receive(userText('/model sonnet'), 'command')
            expect((await engine.getSession(session.id))?.metadata?.promptTitle).toBeUndefined()

            await receive(userText('Fix the login redirect'), 'first')
            await receive(userText('Also update the tests'), 'second')
            const summary = toSessionSummary((await engine.getSession(session.id))!)
            expect(summary.metadata?.promptTitle).toBe('Fix the login redirect')
            expect(summary.metadata?.summary).toBeUndefined()
            const patch = events.find((event) => event.type === 'session-updated'
                && (event.data as { metadata?: { value?: { promptTitle?: string } } } | undefined)?.metadata?.value?.promptTitle)
            expect(patch?.type === 'session-updated' && patch.data).toEqual({
                metadata: { version: summary.metadataVersion, value: expect.objectContaining({ promptTitle: 'Fix the login redirect' }) }
            })

            expect(await (engine as unknown as { sessionCache: SessionCache }).sessionCache.updateAutomaticSessionSummary(session.id, 'Login redirect fix')).toBe(true)
            expect((await engine.getSession(session.id))?.metadata?.summary?.text).toBe('Login redirect fix')
        } finally {
            await engine.stop()
            await store.close()
        }
    })

    it('leaves sessions that already have a title alone', async () => {
        const { store, engine, session, receive } = (await setup({ name: 'Manual name' }))
        try {
            await receive(userText('Fix the login redirect'), 'first')
            expect((await engine.getSession(session.id))?.metadata?.promptTitle).toBeUndefined()
        } finally {
            await engine.stop()
            await store.close()
        }
    })
})
