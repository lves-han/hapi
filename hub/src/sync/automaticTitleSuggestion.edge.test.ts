import { afterEach, describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { SessionCache } from './sessionCache'
import { AutomaticTitleSuggestionService } from './automaticTitleSuggestion'
import { TitleSuggestionService } from './titleSuggestion'
import type { EventPublisher } from './eventPublisher'

const stores: Store[] = []
afterEach(async () => { for (const store of stores.splice(0)) await store.close() })

async function setup(provider = { suggest: async (_prompt: string) => 'Fallback title' }) {
    const store = new Store(':memory:')
    stores.push(store)
    const cache = new SessionCache(store, { emit() {} } as unknown as EventPublisher)
    const session = (await cache.getOrCreateSession('edge-case', { path: '/project', host: 'test' }, null, 'tenant'))
    const service = new TitleSuggestionService(store, { provider })
    const automatic = new AutomaticTitleSuggestionService(cache, service, () => 1000)
    const add = async (role: string, text: string, queued = false) => (await store.messages.addMessage(session.id,
        { role, content: { type: 'text', text } }, queued ? 'queued-id' : undefined))
    return { store, cache, session, service, automatic, add }
}

function deferred() {
    let resolve!: (value: string) => void
    const promise = new Promise<string>(r => { resolve = r })
    return { promise, resolve }
}

describe('automatic title safety and first-turn eligibility', () => {
    it('uses the observed first turn for steering when completion has no ready record', async () => {
        const h = (await setup())
        await h.automatic.onTurnStarted(h.session.id)
        await h.add('user', 'Initial task'); await h.add('assistant', 'Partial output')
        await h.add('user', 'Steering prompt'); await h.add('assistant', 'Final output')
        await h.automatic.onTurnCompleted(h.session.id)
        expect(h.cache.getSession(h.session.id)?.metadata?.summary?.text).toBe('Fallback title')
    })

    it('does not treat an observed later turn without ready records as the first', async () => {
        const h = (await setup())
        await h.add('user', 'Old task'); await h.add('assistant', 'Old answer')
        await h.automatic.onTurnStarted(h.session.id)
        await h.add('user', 'Current task'); await h.add('assistant', 'Current answer')
        await h.automatic.onTurnCompleted(h.session.id)
        expect(h.cache.getSession(h.session.id)?.metadata?.summary).toBeUndefined()
        expect(h.cache.getSession(h.session.id)?.metadata?.titleSuggestionAutoAttemptedAt).toBeUndefined()
    })

    it('allows the first answered turn after an earlier empty completion', async () => {
        const h = (await setup())
        await h.automatic.onTurnStarted(h.session.id)
        await h.add('user', 'Unanswered task')
        await h.automatic.onTurnCompleted(h.session.id)
        expect(h.cache.getSession(h.session.id)?.metadata?.titleSuggestionAutoAttemptedAt).toBeUndefined()
        await h.automatic.onTurnStarted(h.session.id)
        await h.add('user', 'Try again'); await h.add('assistant', 'First answer')
        await h.automatic.onTurnCompleted(h.session.id)
        expect(h.cache.getSession(h.session.id)?.metadata?.summary?.text).toBe('Fallback title')
    })

    it('treats batched initial prompts as one completed turn', async () => {
        const h = (await setup())
        await h.add('user', 'Explain deployment')
        await h.add('user', 'Include rollback')
        await h.add('assistant', 'Deployment and rollback explained')
        await h.automatic.onTurnCompleted(h.session.id)
        expect(h.cache.getSession(h.session.id)?.metadata?.summary?.text).toBe('Fallback title')
    })

    it('includes prompts steered after partial output before the first ready boundary', async () => {
        const h = (await setup())
        await h.add('user', 'Explain deployment')
        await h.add('assistant', 'Checking the workflow')
        await h.add('user', 'Also include rollback')
        await h.add('assistant', 'Deployment and rollback explained')
        await h.store.messages.addMessage(h.session.id, { role: 'agent', content: { type: 'event', data: { type: 'ready' } } })
        await h.automatic.onTurnCompleted(h.session.id)
        expect(h.cache.getSession(h.session.id)?.metadata?.summary?.text).toBe('Fallback title')
    })

    it('does not count a second consumed prompt after an earlier ready as the first turn', async () => {
        const h = (await setup())
        await h.add('user', 'First task')
        await h.add('assistant', 'First answer')
        await h.store.messages.addMessage(h.session.id, { role: 'agent', content: { type: 'event', data: { type: 'ready' } } })
        await h.add('user', 'Second task')
        await h.add('assistant', 'Second answer')
        await h.store.messages.addMessage(h.session.id, { role: 'agent', content: { type: 'event', data: { type: 'ready' } } })
        expect((await h.service.hasCompletedFirstTurn(h.session.id))).toBe(false)
    })

    it('finds a previous ready boundary beyond the provider message window', async () => {
        const h = (await setup())
        await h.add('user', 'First task'); await h.add('assistant', 'First answer')
        await h.store.messages.addMessage(h.session.id, { role: 'agent', content: { type: 'event', data: { type: 'ready' } } })
        await h.add('user', 'Second task')
        for (let i = 0; i < 205; i++) await h.store.messages.addMessage(h.session.id,
            { role: 'agent', content: { type: 'codex', data: { type: 'tool-call', name: 'shell', input: {} } } })
        await h.add('assistant', 'Second answer')
        await h.store.messages.addMessage(h.session.id, { role: 'agent', content: { type: 'event', data: { type: 'ready' } } })
        expect((await h.service.hasCompletedFirstTurn(h.session.id))).toBe(false)
    })

    it('coalesces overlapping completion events into one provider request', async () => {
        const pending = deferred()
        let calls = 0
        const h = (await setup({ suggest: async () => { calls++; return pending.promise } }))
        await h.add('user', 'Explain deployment'); await h.add('assistant', 'Deployment explained')
        const first = h.automatic.onTurnCompleted(h.session.id)
        for (let i = 0; i < 50 && calls === 0; i++) await new Promise(resolve => setTimeout(resolve, 0))
        await h.automatic.onTurnCompleted(h.session.id)
        expect(calls).toBe(1)
        pending.resolve('Deployment')
        await first
        await h.automatic.onTurnCompleted(h.session.id)
        expect(calls).toBe(1)
    })

    it('preserves the attempt across service/cache recreation after provider failure', async () => {
        let calls = 0
        const provider = { suggest: async () => { calls++; throw new Error('offline') } }
        const h = (await setup(provider))
        await h.add('user', 'Explain deployment'); await h.add('assistant', 'Deployment explained')
        await h.automatic.onTurnCompleted(h.session.id)
        const cache = new SessionCache(h.store, { emit() {} } as unknown as EventPublisher)
        await cache.refreshSession(h.session.id)
        const restarted = new AutomaticTitleSuggestionService(cache, new TitleSuggestionService(h.store, { provider }))
        await restarted.onTurnCompleted(h.session.id)
        expect(calls).toBe(1)
    })

    it('retains manual Generate after an automatic failure', async () => {
        let calls = 0
        const h = (await setup({ suggest: async () => { if (++calls === 1) throw new Error('offline'); return 'Manual retry' } }))
        await h.add('user', 'Explain deployment'); await h.add('assistant', 'Deployment explained')
        await h.automatic.onTurnCompleted(h.session.id)
        expect(await h.service.suggestTitle(h.session.id)).toBe('Manual retry')
        expect(calls).toBe(2)
    })

    it('does not apply a provider result after the session is deleted', async () => {
        const pending = deferred()
        const h = (await setup({ suggest: async () => pending.promise }))
        await h.add('user', 'Explain deployment'); await h.add('assistant', 'Deployment explained')
        const work = h.automatic.onTurnCompleted(h.session.id)
        for (let i = 0; i < 50 && !h.cache.getSession(h.session.id)?.metadata?.titleSuggestionAutoAttemptedAt; i++) await new Promise(resolve => setTimeout(resolve, 0))
        await h.store.sessions.deleteSession(h.session.id, 'tenant')
        pending.resolve('Deleted title')
        await work
        expect((await h.store.sessions.getSession(h.session.id))).toBeNull()
    })

    it('does not write a pending result or begin more requests after stop', async () => {
        const pending = deferred()
        let calls = 0
        const h = (await setup({ suggest: async () => { calls++; return pending.promise } }))
        await h.add('user', 'Explain deployment'); await h.add('assistant', 'Deployment explained')
        const work = h.automatic.onTurnCompleted(h.session.id)
        for (let i = 0; i < 50 && calls === 0; i++) await new Promise(resolve => setTimeout(resolve, 0))
        h.automatic.stop()
        pending.resolve('Stopped title')
        await work
        await h.automatic.onTurnCompleted(h.session.id)
        expect(h.cache.getSession(h.session.id)?.metadata?.summary).toBeUndefined()
        expect(calls).toBe(1)
    })

    it('accepts whitespace-only existing title fields without changing session recency', async () => {
        const h = (await setup())
        await h.cache.renameSession(h.session.id, '   ')
        await h.cache.updateSessionSummary(h.session.id, '  ')
        const before = (await h.store.sessions.getSession(h.session.id))!.updatedAt
        await h.add('user', 'Explain deployment'); await h.add('assistant', 'Deployment explained')
        await h.automatic.onTurnCompleted(h.session.id)
        expect(h.cache.getSession(h.session.id)?.metadata?.summary?.text).toBe('Fallback title')
        expect(h.cache.getSession(h.session.id)?.metadata?.name).toBeUndefined()
        expect((await h.store.sessions.getSession(h.session.id))!.updatedAt).toBe(before)
    })

    it('ignores queued follow-up messages when identifying the completed first turn', async () => {
        const h = (await setup())
        await h.add('user', 'First task'); await h.add('assistant', 'First answer'); await h.add('user', 'Queued follow-up', true)
        expect((await h.service.hasCompletedFirstTurn(h.session.id))).toBe(true)
        await h.automatic.onTurnCompleted(h.session.id)
        expect(h.cache.getSession(h.session.id)?.metadata?.summary?.text).toBe('Fallback title')
    })

    it('does not mistake assistant output preceding the first user message for its answer', async () => {
        const h = (await setup())
        await h.add('assistant', 'Welcome'); await h.add('user', 'First task')
        expect((await h.service.hasCompletedFirstTurn(h.session.id))).toBe(false)
    })

    it('finds the first user turn beyond a full window of tool output', async () => {
        const h = (await setup())
        await h.add('user', 'Long first task')
        for (let i = 0; i < 205; i++) await h.store.messages.addMessage(h.session.id,
            { role: 'agent', content: { type: 'codex', data: { type: 'tool-call', name: 'shell', input: {} } } })
        await h.add('assistant', 'Final answer')
        expect((await h.service.hasCompletedFirstTurn(h.session.id))).toBe(true)
    })

    it('does not mistake the most recent turn of a long history for its first turn', async () => {
        const h = (await setup())
        await h.add('user', 'Old task'); await h.add('assistant', 'Old answer')
        for (let i = 0; i < 205; i++) await h.store.messages.addMessage(h.session.id,
            { role: 'agent', content: { type: 'codex', data: { type: 'tool-call', name: 'shell', input: {} } } })
        await h.add('user', 'New task'); await h.add('assistant', 'New answer')
        expect((await h.service.hasCompletedFirstTurn(h.session.id))).toBe(false)
    })

    it('does not count tool results or reasoning as a visible first answer', async () => {
        const h = (await setup())
        await h.add('user', 'First task')
        await h.store.messages.addMessage(h.session.id, { role: 'agent', content: {
            type: 'codex', data: { type: 'tool-call-result', output: 'internal result' }
        } })
        await h.store.messages.addMessage(h.session.id, { role: 'agent', content: {
            type: 'codex', data: { type: 'reasoning', message: 'internal thought' }
        } })
        expect((await h.service.hasCompletedFirstTurn(h.session.id))).toBe(false)
    })
})
