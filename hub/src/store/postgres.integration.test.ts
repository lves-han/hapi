import { describe, expect, it } from 'bun:test'
import { SQL } from 'bun'
import { Database as SQLite } from 'bun:sqlite'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { Hono } from 'hono'
import type { StorageUsageResponse } from '@hapi/protocol/apiTypes'
import type { WebAppEnv } from '../web/middleware/auth'
import { createStorageRoutes } from '../web/routes/storage'
import { Store } from './index'
import { openStore } from './openStore'
import { businessTables } from './postgresSchema'
import { exportPostgres } from './exportPostgres'
import { readScratchlistAttachmentFile, resolveScratchlistStoragePath, writeScratchlistAttachmentFile } from '../scratchlistAttachments/storage'
import { parseHubScratchlistAttachmentPath } from '@hapi/protocol'
import releases from './fixtures/releases-sqlite.json'

const testUrl = process.env.HAPI_TEST_DATABASE_URL

async function isolated(run: (url: string, dir: string, sql: SQL) => Promise<void>): Promise<void> {
    const admin = new SQL(testUrl!, { max: 1 })
    const name = `hapi_test_${randomUUID().replaceAll('-', '')}`
    const dir = mkdtempSync(join(tmpdir(), 'hapi-pg-'))
    const target = new URL(testUrl!)
    target.pathname = '/' + name
    let sql: SQL | undefined
    try {
        await admin.unsafe(`CREATE DATABASE ${name}`)
        sql = new SQL(target.href, { max: 2, bigint: true })
        try { await run(target.href, dir, sql) }
        catch (error) {
            const reportsDir = join(dir, 'migrations')
            try {
                for (const name of readdirSync(reportsDir).filter(name => name.endsWith('.json'))) {
                    const report = JSON.parse(readFileSync(join(reportsDir, name), 'utf8'))
                    if (report.phase === 'failed') console.error('Migration test report:', report.error)
                }
            } catch { /* A preflight failure may precede report creation. */ }
            throw error
        }
    } finally {
        await sql?.close()
        await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
        await admin.close()
        rmSync(dir, { recursive: true, force: true })
    }
}

async function seed(path: string): Promise<string> {
    const store = new Store(path)
    try {
        const session = await store.sessions.getOrCreateSession('seed', { path: '/test', unknown: { unicode: '中文 👋' } }, null, 'default', undefined, undefined, undefined, 'seed-session')
        await store.machines.getOrCreateMachine('seed-machine', { host: 'test' }, { unknown: true }, 'default')
        await store.messages.addMessage(session.id, { role: 'user', text: 'later 中文' }, 'future', 2_000_000_000_000)
        await store.messages.addMessage(session.id, { role: 'user', text: 'large '.repeat(500) }, 'compressed')
        await store.messages.markMessagesIndeterminate(session.id, ['compressed'])
        await store.messages.bumpMessageEpoch(session.id)
        await store.users.addUser('telegram', 'test-user', 'default')
        await store.push.addPushSubscription('default', { endpoint: 'https://example.invalid/push', p256dh: 'public', auth: 'auth' })
        await store.fcm.upsertDevice('default', { token: 'test-token', platform: 'phone', deviceId: 'test-device' })
        await store.scratchlist.create(session.id, 'note 中文')
        await store.usage.recordScan(session.id, 1, 2, [{ sessionId: session.id, sourceKey: 'test', sourceSeq: 1, createdAt: 1, agent: 'codex', model: null, kind: 'delta', inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, lastInputTokens: null, lastOutputTokens: null, lastCacheReadTokens: null, lastCacheCreationTokens: null }], true)
        const event = await store.workGraph.insertEvent('default', { source_kind: 'session', source_ref: session.id, event_type: 'work_ad', summary: 'test', related_session_id: session.id, principal: { kind: 'human', id: '1' } })
        await store.workGraph.insertLink('default', { from_event_id: event.event.id, to_event_id: event.event.id, relation_type: 'related' })
        // Preserve plaintext and oversized historical content without applying ingest truncation.
        store.sqliteDatabase.prepare('INSERT INTO messages (id, session_id, content, created_at, seq, invoked_at) VALUES (?, ?, ?, 0, 3, 0)')
            .run('historical', session.id, JSON.stringify({ text: '历史'.repeat(40_000) }))
        return session.id
    } finally { await store.close() }
}

function fileHash(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex') }

async function historicFixture(path: string, version: number): Promise<void> {
    const store = new Store(path)
    await store.close()
    const db = new SQLite(path)
    try {
        db.exec('PRAGMA foreign_keys = OFF')
        const indexes = db.query("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").all() as { name: string; sql: string }[]
        for (const index of indexes) db.exec(`DROP INDEX ${index.name}`)
        const introducedTables: Record<string, number> = { fcm_devices: 11, session_scratchlist: 12, message_epochs: 13, usage_events: 17, usage_scan_state: 19, events: 23, event_links: 23 }
        for (const [table, introduced] of Object.entries(introducedTables)) if (version < introduced) db.exec(`DROP TABLE ${table}`)
        const introducedColumns: [string, number, string[]][] = [
            ['sessions', 4, ['team_state', 'team_state_updated_at']], ['sessions', 5, ['model']],
            ['sessions', 6, ['effort']], ['sessions', 7, ['model_reasoning_effort']], ['sessions', 10, ['service_tier']],
            ['sessions', 22, ['pinned', 'global_pinned']], ['messages', 8, ['invoked_at']],
            ['messages', 9, ['scheduled_at']], ['messages', 25, ['delivery_state']],
            ['fcm_devices', 24, ['push_key']], ['session_scratchlist', 15, ['attachments']],
            ['usage_events', 18, ['last_input_tokens', 'last_output_tokens', 'last_cache_read_tokens', 'last_cache_creation_tokens']]
        ]
        for (const [table, introduced, columns] of introducedColumns) {
            if (version >= introduced || (introducedTables[table] && version < introducedTables[table])) continue
            for (const column of columns) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`)
        }
        if (version < 2) {
            db.exec('ALTER TABLE machines RENAME COLUMN runner_state TO daemon_state; ALTER TABLE machines RENAME COLUMN runner_state_version TO daemon_state_version')
        }
        for (const index of indexes) {
            const table = / ON (\w+)/.exec(index.sql)?.[1]
            if (table && introducedTables[table] && version < introducedTables[table]) continue
            if ((index.name === 'idx_messages_immediate_queued' && version < 26) || (index.name === 'idx_messages_scheduled_pending' && version < 9) || (index.name === 'idx_messages_session_position' && version < 8)) continue
            db.exec(index.sql)
        }
        db.exec(`PRAGMA user_version = ${version}`)
        db.exec(`INSERT INTO sessions (id, tag, namespace, created_at, updated_at, seq, metadata) VALUES ('historical-session', 'historical', 'old', 1, 1, 0, '{"unknown":{"unicode":"中文"}}')`)
        db.exec(`INSERT INTO messages (id, session_id, content, created_at, seq, local_id) VALUES ('historical-message', 'historical-session', '{"text":"preserved"}', 1, 1, 'historical-local')`)
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } finally { db.close() }
}

describe.skipIf(!testUrl)('PostgreSQL storage and automatic migration', () => {
    it.each(Array.from({ length: 27 }, (_, i) => i))('upgrades and imports historical schema %i without changing its source', async version => {
        await isolated(async (url, dir) => {
            const dbPath = join(dir, 'hapi.db')
            await historicFixture(dbPath, version)
            const before = fileHash(dbPath)
            const store = await openStore({ dbPath, dataDir: dir, databaseUrl: url })
            try {
                expect((await store.sessions.getSession('historical-session'))?.metadata).toEqual({ unknown: { unicode: '中文' } })
                expect((await store.messages.getAllMessages('historical-session'))[0]).toMatchObject({ id: 'historical-message', content: { text: 'preserved' }, invokedAt: version < 8 ? 1 : null })
                expect(fileHash(dbPath)).toBe(before)
            } finally { await store.close() }
        })
    }, 30_000)

    it('imports all 12 tables losslessly, restores identity, and preserves new writes on restart', async () => {
        await isolated(async (url, dir, sql) => {
            const dbPath = join(dir, 'hapi.db')
            const id = await seed(dbPath)
            const before = fileHash(dbPath)
            const expectedStore = new Store(dbPath)
            const expected = await expectedStore.messages.getAllMessages(id)
            await expectedStore.close()
            let store = await openStore({ dbPath, dataDir: dir, databaseUrl: url })
            expect(await store.messages.getAllMessages(id)).toEqual(expected)
            expect(await store.messages.getMessageEpoch(id)).toBe(1)
            expect((await store.sessions.getSession(id))?.metadata).toMatchObject({ unknown: { unicode: '中文 👋' } })
            const [meta] = await sql`SELECT * FROM hapi_store_metadata`
            expect(Object.keys(JSON.parse(meta.summaries))).toEqual([...businessTables])
            for (const table of businessTables) {
                const [row] = await sql.unsafe(`SELECT COUNT(*) AS n FROM ${table}`)
                expect(Number(row.n)).toBeGreaterThan(0)
            }
            const user = await store.users.addUser('telegram', 'new-user', 'default')
            expect(user.id).toBeGreaterThan(1)
            const added = await store.messages.addMessage(id, { text: 'after cutover' }, 'new-local')
            await store.close()
            store = await openStore({ dbPath, dataDir: dir, databaseUrl: url })
            expect((await store.messages.getAllMessages(id)).at(-1)?.id).toBe(added.id)
            expect(await store.messages.countMessages(id)).toBe(expected.length + 1)
            expect(fileHash(dbPath)).toBe(before)
            const exportedPath = join(dir, 'rollback.sqlite')
            await exportPostgres(url, exportedPath)
            const exported = new Store(exportedPath)
            expect(await exported.messages.getAllMessages(id)).toEqual(await store.messages.getAllMessages(id))
            await exported.close()
            await expect(exportPostgres(url, exportedPath)).rejects.toThrow('already exists')
            await store.close()
        })
    }, 30_000)

    it('preserves punctuation, case and Unicode text keys through migration and reverse export', async () => {
        await isolated(async (url, dir, sql) => {
            const dbPath = join(dir, 'hapi.db')
            const id = await seed(dbPath)
            const source = new Store(dbPath)
            const keys = ['key-1', 'key1', 'key_1', 'key:1', 'A', 'a', 'é', '中']
            const insert = source.sqliteDatabase.prepare(`
                INSERT INTO usage_events (session_id, source_key, source_seq, created_at, agent, kind)
                VALUES (?, ?, ?, ?, 'codex', 'delta')
            `)
            for (const [index, key] of keys.entries()) insert.run(id, key, index, index)
            insert.finalize()
            const expected = source.sqliteDatabase.query('SELECT * FROM usage_events ORDER BY session_id, source_key').all()
            await source.close()
            const before = fileHash(dbPath)
            const store = await openStore({ dbPath, dataDir: dir, databaseUrl: url })
            try {
                const [count] = await sql`SELECT COUNT(*) AS n FROM usage_events`
                expect(Number(count.n)).toBe(expected.length)
                const output = join(dir, 'rollback.sqlite')
                await exportPostgres(url, output)
                const exported = new Store(output)
                try {
                    expect(exported.sqliteDatabase.query('SELECT * FROM usage_events ORDER BY session_id, source_key').all()).toEqual(expected)
                } finally { await exported.close() }
                expect(fileHash(dbPath)).toBe(before)
            } finally { await store.close() }
        })
    }, 30_000)

    for (const backend of ['sqlite', 'postgres'] as const) {
        it(`${backend}: reports the active database storage through the owner API`, async () => {
            await isolated(async (url, dir, sql) => {
                const dbPath = join(dir, 'hapi.db')
                const store = await openStore({ dbPath, dataDir: dir, databaseUrl: backend === 'postgres' ? url : undefined })
                try {
                    const app = new Hono<WebAppEnv>()
                    app.use('*', async (c, next) => { c.set('namespace', 'default'); await next() })
                    app.route('/api', createStorageRoutes(dbPath, store))
                    const response = await app.request('/api/storage')
                    expect(response.status).toBe(200)
                    expect(response.headers.get('cache-control')).toBe('no-store')
                    const usage = await response.json() as StorageUsageResponse
                    expect(usage.backend).toBe(backend)
                    expect(usage.totalBytes).toBeGreaterThan(0)
                    const legacy = await app.request('/api/storage/sqlite')
                    if (usage.backend === 'postgres') {
                        const [expected] = await sql`SELECT pg_database_size(current_database()) AS bytes`
                        expect(usage).toEqual({ backend: 'postgres', databaseName: new URL(url).pathname.slice(1), totalBytes: Number(expected.bytes) })
                        expect(legacy.status).toBe(409)
                    } else {
                        expect(usage.path).toBe(dbPath)
                        expect(usage.totalBytes).toBe(usage.databaseBytes + usage.walBytes + usage.shmBytes)
                        expect(legacy.status).toBe(200)
                        const { backend: _, ...expected } = usage
                        expect(await legacy.json()).toEqual(expected)
                    }
                } finally { await store.close() }
            })
        }, 30_000)

        it(`${backend}: cancels queued messages and advances the history epoch exactly once per deletion`, async () => {
            await isolated(async (url, dir) => {
                const store = await openStore({ dbPath: join(dir, 'hapi.db'), dataDir: dir, databaseUrl: backend === 'postgres' ? url : undefined })
                try {
                    const session = await store.sessions.getOrCreateSession('cancel', {}, null, 'default')
                    let epoch = 0
                    expect(await store.messages.getMessageEpoch(session.id)).toBe(epoch)
                    for (const operation of ['cancelQueuedMessage', 'deleteQueuedMessageById'] as const) {
                        for (const byLocalId of [false, true]) {
                            const localId = `${operation}-${byLocalId}`
                            const message = await store.messages.addMessage(session.id, { text: 'queued' }, localId, byLocalId ? 2_000_000_000_000 : undefined)
                            const messageId = byLocalId ? localId : message.id
                            expect(await store.messages[operation](session.id, messageId)).toEqual(
                                operation === 'cancelQueuedMessage' ? { status: 'cancelled', localId } : true
                            )
                            expect(await store.messages.countMessages(session.id)).toBe(0)
                            expect(await store.messages.getMessageEpoch(session.id)).toBe(++epoch)
                            expect(await store.messages[operation](session.id, messageId)).toEqual(
                                operation === 'cancelQueuedMessage' ? { status: 'cancelled', localId: null } : false
                            )
                            expect(await store.messages.getMessageEpoch(session.id)).toBe(epoch)
                        }
                    }
                    const invoked = await store.messages.addMessage(session.id, { text: 'consumed' })
                    expect(await store.messages.deleteQueuedMessageById(session.id, invoked.id)).toBe(false)
                    expect(await store.messages.cancelQueuedMessage(session.id, invoked.id)).toEqual({ status: 'invoked', message: invoked })
                    expect(await store.messages.getAllMessages(session.id)).toEqual([invoked])
                    expect(await store.messages.getMessageEpoch(session.id)).toBe(epoch)
                } finally { await store.close() }
            })
        }, 30_000)

        it(`${backend}: preserves scheduled delivery and auxiliary store behavior`, async () => {
            await isolated(async (url, dir) => {
                const store = await openStore({ dbPath: join(dir, 'hapi.db'), dataDir: dir, databaseUrl: backend === 'postgres' ? url : undefined })
                try {
                    const a = await store.sessions.getOrCreateSession('a', {}, null, 'default')
                    const b = await store.sessions.getOrCreateSession('b', {}, null, 'default')
                    await store.messages.addMessage(a.id, {}, 'future', 2_000)
                    await store.messages.addMessage(a.id, {}, 'unknown', 1_500)
                    await store.messages.markMessagesIndeterminate(a.id, ['unknown'])
                    await store.messages.addMessage(a.id, {}, 'consumed', 1_400)
                    await store.messages.markMessagesInvoked(a.id, ['consumed'], 0)
                    expect(await store.messages.countFutureScheduledBySessionIds([a.id, b.id], 1_000)).toEqual(new Map([[a.id, 1]]))
                    expect(await store.messages.minFutureScheduledAtBySessionIds([a.id], 1_000)).toEqual(new Map([[a.id, 2_000]]))
                    await store.scratchlist.create(a.id, 'source collision', { entryId: 'same' })
                    await store.scratchlist.create(a.id, 'move', { entryId: 'move' })
                    await store.scratchlist.create(b.id, 'target wins', { entryId: 'same' })
                    expect(await store.scratchlist.transfer(a.id, b.id)).toEqual({ moved: 1, collided: 1 })
                    expect((await store.scratchlist.get(b.id, 'same'))?.text).toBe('target wins')
                    expect(await store.scratchlist.count(a.id)).toBe(0)
                    const usage = { sessionId: a.id, sourceKey: 'test', sourceSeq: 1, createdAt: 1, agent: 'codex', model: null, kind: 'delta' as const, inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, lastInputTokens: null, lastOutputTokens: null, lastCacheReadTokens: null, lastCacheCreationTokens: null }
                    await store.usage.recordScan(a.id, 1, 1, [usage], true)
                    await store.usage.recordScan(a.id, 1, 2, [], false)
                    expect(await store.usage.getScanStates([a.id])).toEqual(new Map([[a.id, { messageEpoch: 1, lastSeq: 2 }]]))
                    await store.usage.transferSession(a.id, b.id)
                    expect((await store.usage.getEvents([b.id]))[0]).toEqual({ ...usage, sessionId: b.id })
                    const input = { source_kind: 'session' as const, source_ref: b.id, event_type: 'work_ad' as const, related_session_id: b.id, summary: 'event', principal: { kind: 'human' as const, id: '1' }, idempotency_key: 'once' }
                    const first = await store.workGraph.insertEvent('default', input)
                    expect((await store.workGraph.insertEvent('default', input)).inserted).toBe(false)
                    expect((await store.workGraph.listWorkAdsByRelatedSession('default', b.id))[0].id).toBe(first.event.id)
                    await store.fcm.upsertDevice('default', { token: 'token', platform: 'phone', deviceId: 'device' })
                    expect((await store.fcm.getDevicesByNamespace('default'))[0].token).toBe('token')
                    await store.push.addPushSubscription('default', { endpoint: 'https://example.invalid', p256dh: 'key', auth: 'auth' })
                    expect((await store.push.getPushSubscriptionsByNamespace('default'))[0].endpoint).toBe('https://example.invalid')
                } finally { await store.close() }
            })
        }, 30_000)

        it(`${backend}: serializes concurrent writes, preserves idempotency, versions and rollback`, async () => {
            await isolated(async (url, dir) => {
                const store = await openStore({ dbPath: join(dir, 'hapi.db'), dataDir: dir, databaseUrl: backend === 'postgres' ? url : undefined })
                try {
                    const sessions = await Promise.all(Array.from({ length: 8 }, async () => (await store.sessions.getOrCreateSession('same-tag', {}, null, 'default'))))
                    expect(new Set(sessions.map(session => session.id)).size).toBe(1)
                    const id = sessions[0].id
                    const rows = await Promise.all(Array.from({ length: 24 }, async (_, i) => (await store.messages.addMessage(id, { i }, `local-${i}`))))
                    expect(rows.map(row => row.seq)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1))
                    const repeated = await Promise.all(Array.from({ length: 8 }, async () => (await store.messages.addMessage(id, {}, 'same-local'))))
                    expect(new Set(repeated.map(row => row.id)).size).toBe(1)
                    const results = await Promise.all([(await store.sessions.updateSessionMetadata(id, { writer: 1 }, 1, 'default')), (await store.sessions.updateSessionMetadata(id, { writer: 2 }, 1, 'default'))])
                    expect(results.map(result => result.result).sort()).toEqual(['success', 'version-mismatch'])
                    await expect(store.recordMessagesConsumed(id, ['local-0'], 5_000, 'other')).rejects.toThrow()
                    expect(await store.messages.getLocalMessageStates(id, ['local-0'])).toEqual([{ localId: 'local-0', invokedAt: null }])
                    expect(await store.sessions.getSessionByNamespace(id, 'other')).toBeNull()
                    await expect(store.messages.addMessage('missing', {})).rejects.toThrow()
                    expect(await store.messages.countMessages(id)).toBe(25)
                } finally { await store.close() }
            })
        }, 30_000)
    }

    for (const phase of ['snapshot', 'normalized', 'tables', 'import:messages', 'indexes', 'verified', 'before-commit', 'committed', 'ready']) {
        it(`recovers after failure at ${phase}`, async () => {
            await isolated(async (url, dir, sql) => {
                const dbPath = join(dir, 'hapi.db')
                const id = await seed(dbPath)
                const before = fileHash(dbPath)
                await expect(openStore({ dbPath, dataDir: dir, databaseUrl: url, checkpoint: name => { if (name === phase) throw new Error('injected failure') } })).rejects.toThrow('PostgreSQL initialization failed')
                if (!['committed', 'ready'].includes(phase)) {
                    expect((await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)).toHaveLength(0)
                }
                const store = await openStore({ dbPath, dataDir: dir, databaseUrl: url })
                expect(await store.messages.countMessages(id)).toBe(3)
                expect(fileHash(dbPath)).toBe(before)
                await store.close()
            })
        }, 30_000)
    }

    for (const release of releases) {
        it(`imports the actual ${release.release} release schema ${release.schemaVersion}`, async () => {
            await isolated(async (url, dir) => {
                const dbPath = join(dir, 'hapi.db')
                const source = new SQLite(dbPath)
                source.exec(release.ddl.join(';\n') + `; PRAGMA user_version = ${release.schemaVersion}`)
                source.exec(`INSERT INTO sessions (id, tag, namespace, created_at, updated_at, seq, metadata) VALUES ('release-session', 'release', 'default', 1, 1, 0, '{"unknown":"中文"}'); INSERT INTO messages (id, session_id, content, created_at, seq, local_id, scheduled_at) VALUES ('release-message', 'release-session', '{"text":"hello"}', 1, 1, 'release-local', 2000000000000)`)
                source.close()
                const store = await openStore({ dbPath, dataDir: dir, databaseUrl: url })
                expect((await store.messages.getAllMessages('release-session'))[0]).toMatchObject({ id: 'release-message', localId: 'release-local', invokedAt: null, scheduledAt: 2_000_000_000_000 })
                expect(await store.messages.countFutureScheduledBySessionIds(['release-session'], 1)).toEqual(new Map([['release-session', 1]]))
                await store.close()
            })
        }, 30_000)
    }

    it('rejects conflicting targets, changed sources, corrupt content and newer schemas', async () => {
        await isolated(async (url, dir, sql) => {
            const dbPath = join(dir, 'hapi.db')
            const id = await seed(dbPath)
            await sql`CREATE TABLE unrelated (id integer)`
            await expect(openStore({ dbPath, dataDir: dir, databaseUrl: url })).rejects.toThrow()
            await sql`DROP TABLE unrelated`
            const source = new SQLite(dbPath)
            source.exec('PRAGMA user_version = 27')
            await expect(openStore({ dbPath, dataDir: dir, databaseUrl: url })).rejects.toThrow()
            source.exec('PRAGMA user_version = 26')
            source.prepare('UPDATE messages SET content = ? WHERE id = ?').run('corrupt JSON', 'historical')
            await expect(openStore({ dbPath, dataDir: dir, databaseUrl: url })).rejects.toThrow()
            source.prepare('UPDATE messages SET content = ? WHERE id = ?').run('{}', 'historical')
            source.close()
            const store = await openStore({ dbPath, dataDir: dir, databaseUrl: url })
            await store.close()
            const changed = new Store(dbPath)
            await changed.messages.addMessage(id, { text: 'old writer' })
            await changed.close()
            await expect(openStore({ dbPath, dataDir: dir, databaseUrl: url })).rejects.toThrow()
            const reports = readdirSync(join(dir, 'migrations')).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(dir, 'migrations', name), 'utf8')))
            expect(reports.some(report => String(report.error).includes('source changed'))).toBe(true)
        })
    }, 30_000)

    it('captures committed WAL rows and rejects a source writer during import', async () => {
        await isolated(async (url, dir) => {
            const dbPath = join(dir, 'hapi.db')
            const id = await seed(dbPath)
            const writer = new Store(dbPath)
            writer.sqliteDatabase.exec('PRAGMA wal_autocheckpoint = 0')
            const walMessage = await writer.messages.addMessage(id, { text: 'committed in WAL' }, 'wal-local')
            await expect(openStore({ dbPath, dataDir: dir, databaseUrl: url, checkpoint: async phase => {
                if (phase === 'snapshot') await writer.messages.addMessage(id, { text: 'late writer' }, 'late-local')
            } })).rejects.toThrow()
            await writer.close()
            const store = await openStore({ dbPath, dataDir: dir, databaseUrl: url })
            expect((await store.messages.getAllMessages(id)).map(message => message.id)).toContain(walMessage.id)
            expect(await store.messages.countMessages(id)).toBe(5)
            await store.close()
        })
    }, 30_000)

    it('refuses a concurrent deployment lock, invalid URLs and insufficient application permissions', async () => {
        await isolated(async (url, dir, sql) => {
            const dbPath = join(dir, 'hapi.db')
            const holder = await sql.reserve()
            await holder`SELECT pg_advisory_lock(48415049)`
            try { await expect(openStore({ dbPath, dataDir: dir, databaseUrl: url })).rejects.toThrow() }
            finally { await holder`SELECT pg_advisory_unlock(48415049)`; holder.release() }
            await expect(openStore({ dbPath, dataDir: dir, databaseUrl: 'sqlite://wrong' })).rejects.toThrow()
            await expect(openStore({ dbPath, dataDir: dir, explicitDbPath: true })).rejects.toThrow('DB_PATH does not exist')
            const role = `hapi_low_${randomUUID().replaceAll('-', '')}`
            const admin = new SQL(testUrl!, { max: 1 })
            await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD 'isolated-test-only' NOSUPERUSER NOCREATEDB NOCREATEROLE`)
            try {
                const restricted = new URL(url)
                restricted.username = role
                restricted.password = 'isolated-test-only'
                await expect(openStore({ dbPath, dataDir: dir, databaseUrl: restricted.href })).rejects.toThrow()
                expect(await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`).toHaveLength(0)
            } finally {
                await admin.unsafe(`DROP ROLE ${role}`)
                await admin.close()
            }
        })
    }, 30_000)

    it('validates retained attachment files before importing their references', async () => {
        await isolated(async (url, dir, sql) => {
            const dbPath = join(dir, 'hapi.db')
            const id = await seed(dbPath)
            const source = new Store(dbPath)
            const attachment = await writeScratchlistAttachmentFile(dir, 'default', id, 'sample.txt', 'text/plain', Buffer.from('retained'))
            const [entry] = await source.scratchlist.list(id)
            await source.scratchlist.update(id, entry.entryId, { attachments: [attachment] })
            await source.close()
            rmSync(resolveScratchlistStoragePath(dir, parseHubScratchlistAttachmentPath(attachment.path)!))
            await expect(openStore({ dbPath, dataDir: dir, databaseUrl: url })).rejects.toThrow()
            expect(await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`).toHaveLength(0)
            await writeScratchlistAttachmentFile(dir, 'default', id, 'sample.txt', 'text/plain', Buffer.from('retained'), attachment.id)
            const store = await openStore({ dbPath, dataDir: dir, databaseUrl: url })
            expect((await store.scratchlist.list(id))[0].attachments).toEqual([attachment])
            expect((await readScratchlistAttachmentFile(dir, attachment.path))?.buffer.toString()).toBe('retained')
            await store.close()
        })
    }, 30_000)
})
