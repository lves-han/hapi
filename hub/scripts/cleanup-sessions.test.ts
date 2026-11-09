import { describe, expect, it } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store'
import { deleteSessions } from './cleanup-sessions'

function makeSession(store: Store, tag: string) {
    return store.sessions.getOrCreateSession(tag, { path: `/tmp/${tag}` }, null, 'default')
}

function failSessionDelete(store: Store): void {
    const db = (store as unknown as { db: Database }).db
    db.exec(`
        CREATE TRIGGER fail_session_delete
        BEFORE DELETE ON sessions
        BEGIN
            SELECT RAISE(ABORT, 'forced session delete failure');
        END
    `)
}

describe('cleanup session bulk deletion', () => {
    it('refuses to modify the SQLite source when PostgreSQL is configured', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-cleanup-backend-'))
        const dbPath = join(dir, 'hapi.db')
        try {
            const store = new Store(dbPath)
            const session = await makeSession(store, 'preserved-source')
            await store.close()
            const result = Bun.spawnSync([process.execPath, join(import.meta.dir, 'cleanup-sessions.ts'), '--force'], {
                env: { ...process.env, DATABASE_URL: 'postgresql://localhost/hapi', DB_PATH: dbPath }
            })
            expect(result.exitCode).not.toBe(0)
            expect(result.stderr.toString()).toContain('only supports SQLite')
            const reopened = new Store(dbPath)
            try { expect(await reopened.sessions.getSession(session.id)).not.toBeNull() }
            finally { await reopened.close() }
        } finally { rmSync(dir, { recursive: true, force: true }) }
    })

    it('removes derived content rows with the deleted sessions', async () => {
        const store = new Store(':memory:')
        const first = await makeSession(store, 'cleanup-script-first')
        const second = await makeSession(store, 'cleanup-script-second')
        for (const session of [first, second]) {
            await store.messages.addMessage(session.id, {
                role: 'user',
                content: { type: 'text', text: 'cleanup script phrase' }
            })
        }

        const db = (store as unknown as { db: Database }).db
        expect(deleteSessions(db, [first.id, second.id])).toBe(2)
        expect(await store.messages.searchContent('cleanup script phrase', 'default')).toEqual([])
        expect(await store.sessions.getSession(first.id)).toBeNull()
        expect(await store.sessions.getSession(second.id)).toBeNull()
        await store.close()
    })

    it('rolls back derived cleanup when canonical session deletion fails', async () => {
        const store = new Store(':memory:')
        const first = await makeSession(store, 'cleanup-script-rollback-first')
        const second = await makeSession(store, 'cleanup-script-rollback-second')
        for (const session of [first, second]) {
            await store.messages.addMessage(session.id, {
                role: 'user',
                content: { type: 'text', text: 'cleanup rollback phrase' }
            })
        }
        failSessionDelete(store)

        const db = (store as unknown as { db: Database }).db
        expect(() => deleteSessions(db, [first.id, second.id]))
            .toThrow('forced session delete failure')
        expect(await store.messages.searchContent('cleanup rollback phrase', 'default')).toHaveLength(2)
        expect(await store.sessions.getSession(first.id)).not.toBeNull()
        expect(await store.sessions.getSession(second.id)).not.toBeNull()
        await store.close()
    })
})
