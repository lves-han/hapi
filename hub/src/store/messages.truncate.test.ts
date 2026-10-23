import { describe, expect, it } from 'bun:test'
import { Store } from './index'

describe('truncateMessagesFromLocalId', () => {
    it('deletes the target and later messages and bumps epoch', async () => {
        const store = new Store(':memory:')
        const session = (await store.sessions.getOrCreateSession('t', { path: '/tmp' }, null, 'default'))

        // Mirror real delivery order: invoke each user turn before its agent reply
        // is written. Bulk-stamping invokedAt after the fact collapses timestamps and
        // can leave later agent rows "before" the rewind boundary.
        await store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'one' } }, 'local-1')
        await store.messages.markMessagesInvoked(session.id, ['local-1'], Date.now())
        await store.messages.addMessage(session.id, { role: 'agent', content: { type: 'text', text: 'a1' } })
        await store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'two' } }, 'local-2')
        await store.messages.markMessagesInvoked(session.id, ['local-2'], Date.now())
        await store.messages.addMessage(session.id, { role: 'agent', content: { type: 'text', text: 'a2' } })

        const beforeEpoch = (await store.messages.getMessageEpoch(session.id))
        const result = (await store.messages.truncateMessagesFromLocalId(session.id, 'local-2', []))
        expect(result.deleted).toBeGreaterThanOrEqual(2)
        expect(result.epoch).toBeGreaterThan(beforeEpoch)

        const remaining = (await store.messages.getAllMessages(session.id))
        expect(remaining.some((message) => message.localId === 'local-2')).toBe(false)
        expect(remaining.some((message) => message.localId === 'local-1')).toBe(true)
    })
})
