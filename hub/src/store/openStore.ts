import { Database as SQLite } from 'bun:sqlite'
import { chmodSync, copyFileSync, existsSync, mkdirSync, statfsSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { stat } from 'node:fs/promises'
import { parseHubScratchlistAttachmentPath, ScratchlistAttachmentsArraySchema } from '@hapi/protocol'
import { resolveScratchlistStoragePath } from '../scratchlistAttachments/storage'
import type { TransactionSQL } from 'bun'
import { Store } from './index'
import { PostgresDatabase } from './database'
import { validateMessageContent } from './contentCodec'
import { businessTables, postgresSchema, postgresSchemaVersion } from './postgresSchema'

type Row = Record<string, string | number | bigint | Uint8Array | null>
type Summary = { count: number; sha256: string }
type Options = {
    dbPath: string
    dataDir: string
    databaseUrl?: string
    explicitDbPath?: boolean
    /** Test-only fault injection at durable boundaries; never selected from environment. */
    checkpoint?: (phase: string) => void | Promise<void>
}

export function hashRow(hash: ReturnType<typeof createHash>, row: Row, columns: string[]): void {
    hash.update(JSON.stringify(columns.map(key => {
        const value = row[key]
        if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString('base64') }
        if (typeof value === 'bigint') {
            if (!Number.isSafeInteger(Number(value))) throw new Error(`Unsafe integer in column ${key}`)
            return Number(value)
        }
        if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`Invalid number in column ${key}`)
        return value
    })) + '\n')
}

function columnsFor(db: SQLite, table: string): { name: string; type: string; pk: number }[] {
    const rows = db.query(`PRAGMA table_info(${table})`).all() as { name: string; type: string; pk: number }[]
    return rows.map(({ name, type, pk }) => ({ name, type: type.toUpperCase(), pk }))
}

async function fingerprint(db: SQLite): Promise<string> {
    const hash = createHash('sha256')
    db.exec('BEGIN')
    try {
        hash.update(JSON.stringify(db.query('PRAGMA user_version').get()))
        const tables = db.query("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; sql: string }[]
        for (const { name, sql } of tables) {
            if (!/^[a-z_]+$/.test(name)) throw new Error('Unexpected SQLite table name')
            hash.update(name + sql)
            const columns = columnsFor(db, name)
            const order = columns.filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => `"${column.name}"`)
            if (order.length === 0) order.push('rowid')
            const statement = db.prepare(`SELECT * FROM ${name} ORDER BY ${order.join(',')}`)
            try {
                let count = 0
                for (const row of statement.iterate() as Iterable<Row>) {
                    hashRow(hash, row, columns.map(column => column.name))
                    if (++count % 500 === 0) await setImmediate()
                }
            } finally { statement.finalize() }
        }
        return hash.digest('hex')
    } finally { db.exec('ROLLBACK') }
}

async function validateAttachments(db: SQLite, dataDir: string): Promise<void> {
    const statement = db.prepare('SELECT session_id, entry_id, attachments FROM session_scratchlist WHERE attachments IS NOT NULL')
    try {
        for (const row of statement.iterate() as Iterable<{ session_id: string; entry_id: string; attachments: string }>) {
            const attachments = ScratchlistAttachmentsArraySchema.parse(JSON.parse(row.attachments))
            for (const attachment of attachments) {
                const key = parseHubScratchlistAttachmentPath(attachment.path)
                if (!key) throw new Error(`Invalid attachment reference: session_scratchlist/${row.session_id}/${row.entry_id}`)
                const file = await stat(resolveScratchlistStoragePath(dataDir, key))
                if (!file.isFile() || file.size !== attachment.size) throw new Error(`Attachment size mismatch: session_scratchlist/${row.session_id}/${row.entry_id}/${attachment.id}`)
            }
        }
    } finally { statement.finalize() }
}

async function importTable(tx: TransactionSQL, db: SQLite, table: string, checkpoint?: Options['checkpoint']): Promise<Summary> {
    const columns = columnsFor(db, table)
    const names = columns.map(column => column.name)
    const ordered = table === 'messages' || table === 'events'
    const copyColumns = ordered ? [...names, 'insertion_order'] : names
    const primaryColumns = columns.filter(column => column.pk).sort((a, b) => a.pk - b.pk)
    const primary = primaryColumns.map(column => `"${column.name}"`)
    const order = primary.length ? primary.join(',') : 'rowid'
    // Match SQLite's bytewise text order regardless of the PostgreSQL database locale.
    const postgresOrder = primaryColumns.map(column => `"${column.name}"${column.type === 'TEXT' ? ' COLLATE "C"' : ''}`).join(',') || 'rowid'
    const expected = createHash('sha256')
    const statement = db.prepare(`SELECT *${ordered ? ', rowid AS insertion_order' : ''} FROM ${table} ORDER BY ${order}`)
    let count = 0
    let batch: Row[] = []
    let batchBytes = 0
    const flush = async () => {
        if (!batch.length) return
        const values: unknown[] = []
        const tuples = batch.map(row => '(' + copyColumns.map(column => {
            let value = row[column]
            if (column === 'content') value = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
            values.push(value)
            return `$${values.length}`
        }).join(',') + ')')
        const insert = `INSERT INTO ${table} (${copyColumns.map(name => `"${name}"`).join(',')}) VALUES `
        try {
            await tx.savepoint(savepoint => savepoint.unsafe(insert + tuples.join(','), values))
        } catch (error) {
            // Locate the failing record inside a failed batch; the outer import still rolls back.
            for (let i = 0; i < batch.length; i++) {
                try {
                    await tx.savepoint(savepoint => savepoint.unsafe(insert + '(' + copyColumns.map((_, j) => `$${j + 1}`).join(',') + ')', values.slice(i * copyColumns.length, (i + 1) * copyColumns.length)))
                } catch (recordError) {
                    throw new Error(`Import failed: ${table}, record ${primary.map(key => String(batch[i][key.slice(1, -1)])).join('/')}`, { cause: recordError })
                }
            }
            throw new Error(`Import batch failed: ${table}`, { cause: error })
        }
        batch = []
        batchBytes = 0
        await setImmediate()
    }
    try {
        for (const row of statement.iterate() as Iterable<Row>) {
            try {
                for (const column of columns) {
                    const value = row[column.name]
                    if (column.type.toUpperCase() === 'INTEGER' && value !== null && !Number.isSafeInteger(value)) {
                        throw new Error(`Unsafe integer in column ${column.name}`)
                    }
                }
                if (table === 'messages') validateMessageContent(row.content as string | Uint8Array)
                for (const column of ['metadata', 'agent_state', 'runner_state', 'todos', 'team_state', 'attachments', 'artifact_refs', 'tags', 'payload_json', 'principal_json', 'metadata_json']) {
                    if (typeof row[column] === 'string') JSON.parse(row[column] as string)
                }
                hashRow(expected, row, copyColumns)
                batch.push(row)
                batchBytes += Object.values(row).reduce<number>((bytes, value) => bytes + (typeof value === 'string' ? Buffer.byteLength(value) : value instanceof Uint8Array ? value.byteLength : 8), 0)
                count++
                if (batch.length >= 100 || batchBytes >= 4 * 1024 * 1024) await flush()
            } catch (error) {
                throw new Error(`Import validation failed: ${table}, record ${primary.map(key => String(row[key.slice(1, -1)])).join('/')}`, { cause: error })
            }
        }
        await flush()
    } finally { statement.finalize() }
    await checkpoint?.(`import:${table}`)

    // Read back in bounded batches and hash decoded values in primary-key order.
    const actual = createHash('sha256')
    let offset = 0
    await tx.unsafe(`DECLARE hapi_verify NO SCROLL CURSOR FOR SELECT ${copyColumns.map(name => `"${name}"`).join(',')}${table === 'messages' ? ', content_encoding' : ''} FROM ${table} ORDER BY ${postgresOrder}`)
    while (true) {
        const rows = await tx.unsafe('FETCH FORWARD 100 FROM hapi_verify')
        if (!rows.length) break
        for (const row of rows as Row[]) {
            if (table === 'messages' && row.content_encoding === 'json') row.content = Buffer.from(row.content as Uint8Array).toString('utf8')
            if (table === 'messages') validateMessageContent(row.content as string | Uint8Array)
            hashRow(actual, row, copyColumns)
        }
        offset += rows.length
        await setImmediate()
    }
    await tx.unsafe('CLOSE hapi_verify')
    const sha256 = expected.digest('hex')
    if (offset !== count || actual.digest('hex') !== sha256) throw new Error(`Imported data mismatch: ${table}`)
    return { count, sha256 }
}

export async function openStore(options: Options): Promise<Store> {
    if (options.explicitDbPath && !existsSync(options.dbPath)) throw new Error('Configured DB_PATH does not exist')
    if (!options.databaseUrl) return new Store(options.dbPath)
    const reportsDir = join(options.dataDir, 'migrations')
    mkdirSync(reportsDir, { recursive: true, mode: 0o700 })
    chmodSync(reportsDir, 0o700)
    const reportPath = join(reportsDir, `${Date.now()}-${randomUUID()}.json`)
    const report: Record<string, unknown> = { importerVersion: 1, targetSchema: postgresSchemaVersion, startedAt: new Date().toISOString(), phase: 'lock' }
    const saveReport = () => writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 })
    const deploymentLock = new SQLite(join(reportsDir, 'deployment-lock.sqlite'), { create: true })
    chmodSync(join(reportsDir, 'deployment-lock.sqlite'), 0o600)
    let database: PostgresDatabase | undefined
    let source: SQLite | undefined
    let working: Store | undefined
    let canonical: Store | undefined
    let reserved: Awaited<ReturnType<PostgresDatabase['sql']['reserve']>> | undefined
    let failed = false
    try {
        deploymentLock.exec('PRAGMA locking_mode = EXCLUSIVE; CREATE TABLE IF NOT EXISTS deployment_lock (id INTEGER); BEGIN EXCLUSIVE')
        database = new PostgresDatabase(options.databaseUrl)
        reserved = await database.sql.reserve()
        const [lock] = await reserved`SELECT pg_try_advisory_lock(48415049) AS acquired`
        if (!lock.acquired) throw new Error('Another Hub holds the database deployment lock')
        const [meta] = await reserved`SELECT to_regclass('public.hapi_store_metadata') AS name`
        if (meta.name) {
            const [record] = await reserved`SELECT * FROM hapi_store_metadata WHERE id = 1`
            if (!record || Number(record.schema_version) !== postgresSchemaVersion) throw new Error('Unsupported PostgreSQL schema metadata')
            if (record.source_fingerprint && existsSync(options.dbPath)) {
                source = new SQLite(options.dbPath, { readonly: true })
                if (await fingerprint(source) !== record.source_fingerprint) throw new Error('SQLite source changed after PostgreSQL migration; stop the old Hub writer and reconcile both databases')
            }
            for (const table of businessTables) await reserved.unsafe(`SELECT 1 FROM ${table} LIMIT 0`)
            report.phase = 'already-complete'
            saveReport()
            return new Store(options.dbPath, database)
        }
        const existing = await reserved`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
        if (existing.length) throw new Error('PostgreSQL contains tables without migration metadata')
        canonical = new Store(':memory:')
        const schemaDb = canonical.sqliteDatabase
        const schema = postgresSchema(schemaDb)
        let sourceFingerprint: string | null = null
        let sourceDataVersion: number | undefined
        if (existsSync(options.dbPath)) {
            report.phase = 'snapshot'
            source = new SQLite(options.dbPath, { readonly: true, strict: true })
            const version = source.query('PRAGMA user_version').get() as { user_version: number }
            report.sourceSchema = version.user_version
            if (version.user_version > postgresSchemaVersion) throw new Error('SQLite schema is newer than the supported baseline')
            const sourceTables = source.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]
            const unknown = sourceTables.filter(row => !businessTables.some(table => table === row.name))
            if (unknown.length) {
                report.unrecognizedTables = unknown.map(row => row.name)
                throw new Error('SQLite structure contains unrecognized tables; compatibility review required')
            }
            sourceDataVersion = (source.query('PRAGMA data_version').get() as { data_version: number }).data_version
            sourceFingerprint = await fingerprint(source)
            const sourceCounts: Record<string, number> = {}
            for (const table of businessTables) {
                if (columnsFor(source, table).length) sourceCounts[table] = (source.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
            }
            report.sourceCounts = sourceCounts
            const pages = source.query('PRAGMA page_count').get() as { page_count: number }
            const size = source.query('PRAGMA page_size').get() as { page_size: number }
            const space = statfsSync(reportsDir)
            if (space.bavail * space.bsize < pages.page_count * size.page_size * 3) throw new Error('Insufficient disk space for SQLite snapshot and working copy')
            const snapshot = reportPath.replace(/\.json$/, '.source.sqlite')
            const workPath = reportPath.replace(/\.json$/, '.working.sqlite')
            source.prepare('VACUUM INTO ?').run(snapshot)
            chmodSync(snapshot, 0o600)
            await options.checkpoint?.('snapshot')
            copyFileSync(snapshot, workPath)
            chmodSync(workPath, 0o600)
            report.snapshot = snapshot
            report.workingCopy = workPath
            report.sourceFingerprint = sourceFingerprint
            report.phase = 'normalize'
            working = new Store(workPath)
            const check = working.sqliteDatabase.query('PRAGMA quick_check').get() as { quick_check: string }
            if (check.quick_check !== 'ok') throw new Error('SQLite integrity check failed')
            const foreignKeys = working.sqliteDatabase.query('PRAGMA foreign_key_check').all()
            if (foreignKeys.length) {
                report.foreignKeyViolations = foreignKeys.slice(0, 20)
                throw new Error('SQLite foreign key check failed; table and row IDs recorded in report')
            }
            for (const table of businessTables) {
                const expected = columnsFor(schemaDb, table)
                const actual = columnsFor(working.sqliteDatabase, table)
                if (JSON.stringify(expected.sort((a,b) => a.name.localeCompare(b.name))) !== JSON.stringify(actual.sort((a,b) => a.name.localeCompare(b.name)))) throw new Error(`Unexpected SQLite structure: ${table}`)
            }
            await validateAttachments(working.sqliteDatabase, options.dataDir)
            await options.checkpoint?.('normalized')
        }
        report.phase = 'import'
        const summaries: Record<string, Summary> = {}
        await reserved.begin(async tx => {
            for (const sql of schema.tables) await tx.unsafe(sql)
            await options.checkpoint?.('tables')
            if (working) {
                for (const table of businessTables) {
                    report.table = table
                    summaries[table] = await importTable(tx, working.sqliteDatabase, table, options.checkpoint)
                }
            }
            for (const sql of schema.indexes) await tx.unsafe(sql)
            await options.checkpoint?.('indexes')
            for (const [table, column] of [['users', 'id'], ['push_subscriptions', 'id'], ['fcm_devices', 'id'], ['messages', 'insertion_order'], ['events', 'insertion_order']]) {
                await tx.unsafe(`SELECT setval(pg_get_serial_sequence('${table}', '${column}'), GREATEST(COALESCE(MAX(${column}), 0), 1), COALESCE(MAX(${column}), 0) >= 1) FROM ${table}`)
            }
            if (source && (source.query('PRAGMA data_version').get() as { data_version: number }).data_version !== sourceDataVersion) throw new Error('SQLite source changed during migration')
            await options.checkpoint?.('verified')
            await tx.unsafe(`CREATE TABLE hapi_store_metadata (id INTEGER PRIMARY KEY CHECK (id = 1), schema_version BIGINT NOT NULL, importer_version INTEGER NOT NULL, source_fingerprint TEXT, summaries TEXT NOT NULL, completed_at BIGINT NOT NULL)`)
            await tx`INSERT INTO hapi_store_metadata VALUES (1, ${postgresSchemaVersion}, 1, ${sourceFingerprint}, ${JSON.stringify(summaries)}, ${Date.now()})`
            await options.checkpoint?.('before-commit')
        })
        await options.checkpoint?.('committed')
        report.phase = 'analyze'
        for (const table of businessTables) await reserved.unsafe(`ANALYZE ${table}`)
        await reserved`SELECT COUNT(*), MIN(scheduled_at) FROM messages WHERE scheduled_at IS NOT NULL AND invoked_at IS NULL AND delivery_state = 'queued'`
        report.phase = 'complete'
        report.summaries = summaries
        report.completedAt = new Date().toISOString()
        saveReport()
        await options.checkpoint?.('ready')
        return new Store(options.dbPath, database)
    } catch (error) {
        failed = true
        report.phaseFailed = report.phase
        report.phase = 'failed'
        report.error = error instanceof Error ? error.message : 'Unknown migration failure'
        try { saveReport() }
        catch { throw new Error('PostgreSQL initialization failed and the restricted migration report could not be written') }
        throw new Error(`PostgreSQL initialization failed; restricted report: ${reportPath}`)
    } finally {
        if (reserved) {
            await reserved`SELECT pg_advisory_unlock(48415049)`.catch(() => undefined)
            reserved.release()
        }
        if (failed) await database?.close().catch(() => undefined)
        await working?.close()
        await canonical?.close()
        source?.close()
        deploymentLock.close()
    }
}
