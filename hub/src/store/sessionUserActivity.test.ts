import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './index'

const stores: Store[] = []
const dirs: string[] = []
afterEach(async () => {
    for (const store of stores.splice(0)) await store.close()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function open(path = ':memory:'): Store {
    const store = new Store(path)
    stores.push(store)
    return store
}
const user = (text = 'hello') => ({ role: 'user', content: { type: 'text', text } })
const create = async (store: Store, tag = 's') => (await store.sessions.getOrCreateSession(tag, { path: '/tmp', host: 'mac' }, null, 'default'))

describe('persisted last user-message time', () => {
    it('advances only for new human input, including attachment-only input', async () => {
        const store = open()
        const session = (await create(store))
        const at = async () => (await store.sessions.getSession(session.id))?.lastUserMessageAt
        expect((await at())).toBeUndefined()
        await store.messages.addMessage(session.id, user(), 'prompt', null, 100)
        expect((await at())).toBe(100)
        await store.messages.addMessage(session.id, user(), 'prompt', null, 900) // duplicate
        await store.messages.addMessage(session.id, { role: 'agent', content: { type: 'output', data: { type: 'user', message: { content: 'tool result' } } } }, undefined, null, 1_000)
        await store.messages.addMessage(session.id, { ...user(), meta: { isTranscriptEcho: true } }, undefined, null, 2_000)
        await store.recordMessagesConsumed(session.id, ['prompt'], 3_000, 'default')
        await store.sessions.touchSessionUpdatedAt(session.id, 4_000, 'default')
        expect((await at())).toBe(100)
        await store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: '', attachments: [{ name: 'image.png' }] } }, 'attachment', null, 500)
        expect((await at())).toBe(500)
    })

    it('preserves original time through import, copy, merge and restart', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-user-activity-'))
        dirs.push(dir)
        const path = join(dir, 'db')
        const store = open(path)
        const source = (await create(store, 'source'))
        const target = (await create(store, 'target'))
        await store.messages.addImportedMessage(source.id, user('imported'), 'original', 500)
        await store.messages.addImportedMessage(source.id, user('imported'), 'original', 900)
        await store.messages.addImportedMessage(source.id, user('older'), 'older', 100)
        expect((await store.sessions.getSession(source.id))?.lastUserMessageAt).toBe(500)
        await store.messages.copyMessagesToSession(target.id, (await store.messages.getAllMessages(source.id)))
        expect((await store.sessions.getSession(target.id))?.lastUserMessageAt).toBe(500)
        await store.messages.addMessage(source.id, user('new'), 'new', null, 700)
        await store.messages.mergeSessionMessages(source.id, target.id)
        expect((await store.sessions.getSession(target.id))?.lastUserMessageAt).toBe(700)
        stores.splice(stores.indexOf(store), 1)
        await store.close()
        expect((await open(path).sessions.getSession(target.id))?.lastUserMessageAt).toBe(700)
    })

    it('migrates plaintext/compressed history once, ignoring tool results and prompt echoes', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-user-activity-migration-'))
        dirs.push(dir)
        const path = join(dir, 'db')
        const store = open(path)
        const session = (await create(store))
        const empty = (await create(store, 'empty'))
        await store.messages.addMessage(session.id, user(), 'plain', null, 100)
        await store.messages.addMessage(session.id, user('compressed '.repeat(500)), 'compressed', null, 200)
        await store.messages.addMessage(session.id, { role: 'agent', content: { type: 'text', text: 'later' } }, undefined, null, 300)
        await store.messages.addMessage(session.id, { ...user(), meta: { isTranscriptEcho: true } }, undefined, null, 400)
        stores.splice(stores.indexOf(store), 1)
        await store.close()
        const db = new Database(path)
        db.exec('ALTER TABLE sessions DROP COLUMN last_user_message_at; PRAGMA user_version = 28;')
        db.close()
        const migrated = open(path)
        expect((await migrated.sessions.getSession(session.id))?.lastUserMessageAt).toBe(200)
        expect((await migrated.sessions.getSession(empty.id))?.lastUserMessageAt).toBeUndefined()
    })
})
