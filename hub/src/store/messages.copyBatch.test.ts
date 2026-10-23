import { describe, expect, it } from 'bun:test'
import { Store } from './index'

describe('copyMessagesToSession', () => {
    it('copies a prefix in one transaction and bumps epoch once', async () => {
        const store = new Store(':memory:')
        const source = (await store.sessions.getOrCreateSession('src', { path: '/tmp' }, null, 'default'))
        const child = (await store.sessions.getOrCreateSession('child', { path: '/tmp' }, null, 'default'))

        await store.messages.addMessage(source.id, { role: 'user', content: { type: 'text', text: 'one' } }, 'local-1')
        await store.messages.markMessagesInvoked(source.id, ['local-1'], Date.now())
        await store.messages.addMessage(source.id, { role: 'agent', content: { type: 'text', text: 'a1' } })
        await store.messages.addMessage(source.id, { role: 'user', content: { type: 'text', text: 'two' } }, 'local-2')
        await store.messages.markMessagesInvoked(source.id, ['local-2'], Date.now())

        const beforeEpoch = (await store.messages.getMessageEpoch(child.id))
        const prefix = (await store.messages.getAllMessages(source.id)).slice(0, 2)
        const copied = (await store.messages.copyMessagesToSession(
            child.id,
            prefix.map((message) => ({
                content: message.content,
                createdAt: message.createdAt,
                localId: message.localId,
                invokedAt: message.invokedAt,
                scheduledAt: message.scheduledAt
            }))
        ))

        expect(copied).toBe(2)
        expect((await store.messages.getAllMessages(child.id))).toHaveLength(2)
        expect((await store.messages.getMessageEpoch(child.id))).toBe(beforeEpoch + 1)
    })
})
