import { describe, expect, it } from 'bun:test'
import { Store } from '.'

const reply = (text: string) => ({ role: 'agent', content: { type: 'codex', data: { type: 'message', message: text } } })

describe('session read state', () => {
    it('counts readable output atomically, deduplicates replay and excludes metadata and history imports', async () => {
        const store = new Store(':memory:')
        try {
            const session = (await store.sessions.getOrCreateSession('s', {}, null, 'default'))
            const id = session.id
            expect(session.contentRevision).toBe(0)
            await store.messages.addImportedMessage(id, reply('old history'), 'import', 1)
            await store.messages.addMessage(id, { role: 'user', content: { type: 'text', text: 'hello' } }, 'user')
            await store.messages.addMessage(id, { role: 'agent', content: { type: 'codex', data: { type: 'reasoning', message: 'thinking' } } }, 'reason')
            await store.sessions.updateSessionMetadata(id, { name: 'Changed' }, session.metadataVersion, 'default')
            expect((await store.sessions.getSession(id))?.contentRevision).toBe(0)
            const first = (await store.messages.addMessage(id, reply('answer'), 'reply'))
            expect(first.contentRevision).toBe(1)
            expect((await store.messages.addMessage(id, reply('answer'), 'reply')).contentRevision).toBe(1)
            expect((await store.sessions.getSession(id))?.contentRevision).toBe(1)
            expect((await store.messages.getMessages(id)).find(m => m.id === first.id)?.contentRevision).toBe(1)
        } finally { await store.close() }
    })

    it('a delayed read never consumes a newer reply or another namespace', async () => {
        const store = new Store(':memory:')
        try {
            const { id } = (await store.sessions.getOrCreateSession('s', {}, null, 'one'))
            await store.messages.addMessage(id, reply('first'), 'one')
            await store.messages.addMessage(id, reply('second'), 'two')
            expect((await store.sessions.updateReadState(id, 'other', { type: 'read', readRevision: 2, expectedVersion: 0 }))).toBeNull()
            const result = (await store.sessions.updateReadState(id, 'one', { type: 'read', readRevision: 1, expectedVersion: 0 }))!
            expect(result.readState.readRevision).toBe(1)
            expect(result.contentRevision).toBe(2)
            expect((await store.sessions.updateReadState(id, 'one', { type: 'read', readRevision: 99, expectedVersion: 0 }))?.status).toBe('invalid')
            expect((await store.sessions.updateReadState(id, 'one', { type: 'read', readRevision: 0, expectedVersion: 0 }))?.readState).toEqual(result.readState)
        } finally { await store.close() }
    })

    it('stale automatic reads cannot erase a newer manual unread operation', async () => {
        const store = new Store(':memory:')
        try {
            const { id } = (await store.sessions.getOrCreateSession('s', {}, null, 'default'))
            await store.messages.addMessage(id, reply('answer'), 'reply')
            const unread = (await store.sessions.updateReadState(id, 'default', { type: 'unread', expectedVersion: 0 }))!
            expect(unread.readState.manualUnread).toBe(true)
            const staleRead = (await store.sessions.updateReadState(id, 'default', { type: 'read', readRevision: 1, expectedVersion: 0 }))!
            expect(staleRead.readState.manualUnread).toBe(true)
            expect(staleRead.readState.readRevision).toBe(1)
            expect((await store.sessions.updateReadState(id, 'default', { type: 'unread', expectedVersion: 0 }))?.status).toBe('conflict')
            const read = (await store.sessions.updateReadState(id, 'default', { type: 'read', readRevision: 1, expectedVersion: staleRead.readState.version }))!
            expect(read.readState.manualUnread).toBe(false)
            expect((await store.sessions.getSession(id))?.updatedAt).toBe((await store.sessions.getSession(id))?.createdAt)
        } finally { await store.close() }
    })
})

describe('read revisions across history changes', () => {
    it('translates unread source output without comparing two session revision domains', async () => {
        const store = new Store(':memory:')
        try {
            const source = (await store.sessions.getOrCreateSession('source', {}, null, 'default')).id
            const target = (await store.sessions.getOrCreateSession('target', {}, null, 'default')).id
            await store.messages.addMessage(source, reply('read history'), 'a')
            await store.sessions.updateReadState(source, 'default', { type: 'read', readRevision: 1, expectedVersion: 0 })
            await store.messages.addMessage(source, reply('unread history'), 'b')
            await store.sessions.updateReadState(source, 'default', { type: 'unread', expectedVersion: 1 })
            await store.messages.addMessage(target, reply('target output'), 'c')
            await store.sessions.updateReadState(target, 'default', { type: 'read', readRevision: 1, expectedVersion: 0 })
            await store.messages.mergeSessionMessages(source, target)
            const state = (await store.sessions.getSession(target))!
            expect(state.contentRevision).toBe(2)
            expect(state.readState).toEqual({ readRevision: 1, manualUnread: true, version: 2 })
            expect((await store.messages.getMessages(target)).find(m => m.localId === 'a')?.contentRevision).toBeUndefined()
            expect((await store.messages.getMessages(target)).find(m => m.localId === 'b')?.contentRevision).toBe(2)
            expect((await store.sessions.getSession(source))?.readState).toEqual({ readRevision: 2, manualUnread: false, version: 3 })
            await store.messages.mergeSessionMessages(source, target)
            expect((await store.sessions.getSession(target))?.contentRevision).toBe(2)
        } finally { await store.close() }
    })

    it('rewind retires removed unread output without reusing its revisions', async () => {
        const store = new Store(':memory:')
        try {
            const id = (await store.sessions.getOrCreateSession('s', {}, null, 'default')).id
            await store.messages.addMessage(id, { role: 'user', content: { type: 'text', text: 'point' } }, 'point', null, 1)
            await store.messages.addMessage(id, reply('removed output'), 'a', null, 2)
            await store.sessions.updateReadState(id, 'default', { type: 'unread', expectedVersion: 0 })
            await store.messages.truncateMessagesFromLocalId(id, 'point')
            expect((await store.sessions.getSession(id))?.contentRevision).toBe(1)
            expect((await store.sessions.getSession(id))?.readState).toEqual({ readRevision: 1, manualUnread: true, version: 2 })
            expect((await store.messages.addMessage(id, reply('new output'), 'b')).contentRevision).toBe(2)
        } finally { await store.close() }
    })
})
