import { describe, expect, it } from 'bun:test'
import type { Database } from 'bun:sqlite'
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

describe('truncateOpenCodeRewind invocation position', () => {
    for (const cutoffFirst of [true, false]) {
        it(`removes the invocation suffix when ${cutoffFirst ? 'the boundary' : 'a later turn'} was inserted first`, async () => {
            const store = new Store(':memory:')
            const session = await store.sessions.getOrCreateSession('ordered-rewind', { path: '/tmp' }, null, 'default')
            const at = Date.now() - 10_000
            const input = async (localId: string, created: number, invoked: number) => {
                const message = await store.messages.addMessage(session.id,
                    { role: 'user', content: { type: 'text', text: localId } }, localId, at + invoked, at + created)
                await store.messages.markMessagesInvoked(session.id, [localId], at + invoked)
                return message
            }
            try {
                const first = await input(cutoffFirst ? 'boundary' : 'later', 0, cutoffFirst ? 300 : 400)
                const prefix = await input('prefix', 100, 100)
                const second = await input(cutoffFirst ? 'later' : 'boundary', 200, cutoffFirst ? 400 : 300)
                const boundary = cutoffFirst ? first : second
                const beforeEpoch = await store.messages.getMessageEpoch(session.id)
                expect((await store.messages.truncateOpenCodeRewind(session.id, boundary.seq, boundary.id))).toBe(beforeEpoch + 1)
                expect((await store.messages.getAllMessages(session.id)).map(message => message.id)).toEqual([prefix.id])
                expect((await store.messages.searchContentInSession('prefix', 'default', session.id)).matches.map(match => match.messageId)).toEqual([prefix.id])
                expect((await store.messages.searchContent('boundary', 'default'))).toEqual([])
                expect((await store.messages.searchContent('later', 'default'))).toEqual([])
            } finally { await store.close() }
        })
    }

    it('uses created_at for null invocation times and seq to break equal-position ties', async () => {
        const store = new Store(':memory:')
        const session = await store.sessions.getOrCreateSession('rewind-ties', { path: '/tmp' }, null, 'default')
        const db = (store as unknown as { db: Database }).db
        const at = Date.now() - 10_000
        try {
            const add = (text: string) => store.messages.addMessage(session.id,
                { role: 'agent', content: { type: 'text', text } }, undefined, undefined, at)
            const prefix = await add('tieprefix')
            const boundary = await add('tieboundary')
            const suffix = await add('tiesuffix')
            db.query('UPDATE messages SET invoked_at = NULL WHERE id IN (?, ?)').run(prefix.id, suffix.id)
            await store.messages.truncateOpenCodeRewind(session.id, boundary.seq, boundary.id)
            expect((await store.messages.getAllMessages(session.id)).map(message => message.id)).toEqual([prefix.id])
        } finally { await store.close() }
    })

    it('refuses a missing session boundary without deleting rows or bumping epoch', async () => {
        const store = new Store(':memory:')
        const session = await store.sessions.getOrCreateSession('missing-rewind', { path: '/tmp' }, null, 'default')
        try {
            const first = await store.messages.addMessage(session.id, { role: 'agent', content: 'keep' })
            const second = await store.messages.addMessage(session.id, { role: 'agent', content: 'also keep' })
            const otherSession = await store.sessions.getOrCreateSession('other-rewind', { path: '/tmp' }, null, 'other')
            const other = await store.messages.addMessage(otherSession.id, { role: 'agent', content: 'other session' })
            const before = await store.messages.getAllMessages(session.id)
            const epoch = await store.messages.getMessageEpoch(session.id)
            for (const [seq, id] of [[999, first.id], [first.seq, second.id], [first.seq, other.id]] as const) {
                expect(() => store.messages.truncateOpenCodeRewind(session.id, seq, id)).toThrow('Rewind boundary not found')
            }
            expect((await store.messages.getAllMessages(session.id))).toEqual(before)
            expect((await store.messages.getMessageEpoch(session.id))).toBe(epoch)
        } finally { await store.close() }
    })
})
