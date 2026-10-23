import { SQL } from 'bun'
import { existsSync, linkSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { Store } from './index'
import { businessTables, postgresSchemaVersion } from './postgresSchema'
import { hashRow } from './openStore'
import { validateMessageContent } from './contentCodec'

/** Offline reverse migration, including every write made after the PostgreSQL cutover. */
export async function exportPostgres(databaseUrl: string, output: string): Promise<void> {
    if (existsSync(output)) throw new Error('Export output already exists')
    const workPath = `${output}.${randomUUID()}.working.sqlite`
    const sql = new SQL(databaseUrl, { max: 1, bigint: true })
    const reserved = await sql.reserve()
    let store: Store | undefined
    const summaries: Record<string, { count: number; sha256: string }> = {}
    try {
        const [lock] = await reserved`SELECT pg_try_advisory_lock(48415049) AS acquired`
        if (!lock.acquired) throw new Error('Stop all Hub writers before exporting PostgreSQL')
        store = new Store(workPath)
        const db = store.sqliteDatabase
        await reserved.begin('isolation level repeatable read read only', async tx => {
            const [meta] = await tx`SELECT schema_version FROM hapi_store_metadata WHERE id = 1`
            if (Number(meta?.schema_version) !== postgresSchemaVersion) throw new Error('Unsupported PostgreSQL schema')
            db.exec('BEGIN IMMEDIATE')
            try {
                for (const table of businessTables) {
                    const info = db.query(`PRAGMA table_info(${table})`).all() as { name: string; type: string; pk: number }[]
                    const columns = info.map(column => column.name)
                    const ordered = table === 'messages' || table === 'events'
                    const copyColumns = ordered ? [...columns, 'insertion_order'] : columns
                    const insertColumns = ordered ? [...columns, 'rowid'] : columns
                    const primary = info.filter(column => column.pk).sort((a, b) => a.pk - b.pk)
                    const order = primary.map(column => `"${column.name}"`).join(',')
                    const postgresOrder = primary.map(column => `"${column.name}"${column.type === 'TEXT' ? ' COLLATE "C"' : ''}`).join(',')
                    const expected = createHash('sha256')
                    const insert = db.prepare(`INSERT INTO ${table} (${insertColumns.map(name => `"${name}"`).join(',')}) VALUES (${insertColumns.map(() => '?').join(',')})`)
                    await tx.unsafe(`DECLARE hapi_export NO SCROLL CURSOR FOR SELECT * FROM ${table} ORDER BY ${postgresOrder}`)
                    let count = 0
                    try {
                        while (true) {
                            const rows = await tx.unsafe('FETCH FORWARD 100 FROM hapi_export')
                            if (!rows.length) break
                            for (const row of rows) {
                                for (const key of copyColumns) {
                                    if (typeof row[key] === 'bigint') {
                                        const value = Number(row[key])
                                        if (!Number.isSafeInteger(value)) throw new Error(`Unsafe integer in ${table}.${key}`)
                                        row[key] = value
                                    }
                                }
                                if (table === 'messages') {
                                    if (row.content_encoding === 'json') row.content = Buffer.from(row.content).toString('utf8')
                                    else if (row.content_encoding !== 'zstd') throw new Error('Unknown message content encoding')
                                    validateMessageContent(row.content)
                                }
                                hashRow(expected, row, copyColumns)
                                insert.run(...copyColumns.map(column => row[column]))
                                count++
                            }
                            await setImmediate()
                        }
                    } finally {
                        insert.finalize()
                        await tx.unsafe('CLOSE hapi_export')
                    }
                    const actual = createHash('sha256')
                    const verify = db.prepare(`SELECT *${ordered ? ', rowid AS insertion_order' : ''} FROM ${table} ORDER BY ${order}`)
                    try {
                        for (const row of verify.iterate()) hashRow(actual, row as Record<string, string | number | null>, copyColumns)
                    } finally { verify.finalize() }
                    const sha256 = expected.digest('hex')
                    if (actual.digest('hex') !== sha256) throw new Error(`Reverse migration digest mismatch: ${table}`)
                    summaries[table] = { count, sha256 }
                }
                if (db.query('PRAGMA foreign_key_check').all().length) throw new Error('Exported SQLite foreign keys are invalid')
                db.exec('COMMIT')
            } catch (error) {
                db.exec('ROLLBACK')
                throw error
            }
        })
        store.sqliteDatabase.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        await store.close()
        store = undefined
        // Hard-link publication is atomic and refuses to overwrite a concurrently created output.
        linkSync(workPath, output)
        rmSync(workPath)
        writeFileSync(`${output}.report.json`, JSON.stringify({ schema: postgresSchemaVersion, exportedAt: new Date().toISOString(), summaries }, null, 2), { flag: 'wx', mode: 0o600 })
    } finally {
        await store?.close()
        await reserved`SELECT pg_advisory_unlock(48415049)`.catch(() => undefined)
        reserved.release()
        await sql.close()
        for (const path of [workPath, `${workPath}-wal`, `${workPath}-shm`]) rmSync(path, { force: true })
    }
}
