import { AsyncLocalStorage } from 'node:async_hooks'
import type { Database as SQLite, Statement } from 'bun:sqlite'
import { SQL, type TransactionSQL } from 'bun'

export interface AsyncStatement<Row = unknown, Params extends unknown[] = unknown[]> {
    get(...params: Params): Promise<Row | undefined>
    all(...params: Params): Promise<Row[]>
    run(...params: Params): Promise<{ changes: number }>
    iterate(...params: Params): AsyncIterable<Row>
    finalize(): void
}

export interface Database {
    readonly backend: 'sqlite' | 'postgres'
    prepare<Row = unknown, Params extends unknown[] = unknown[]>(sql: string): AsyncStatement<Row, Params>
    exec(sql: string): Promise<void>
    transaction<T>(callback: () => Promise<T>): () => Promise<T>
    operation<T>(callback: () => Promise<T>, write: boolean): Promise<T>
    close(): Promise<void>
}

// Async SQLite transactions must own the connection until their last await.
export class SQLiteDatabase implements Database {
    readonly backend = 'sqlite' as const
    private readonly context = new AsyncLocalStorage<boolean>()
    private tail: Promise<unknown> = Promise.resolve()
    private savepoint = 0
    constructor(private readonly db: SQLite) {}
    prepare<Row = unknown, Params extends unknown[] = unknown[]>(sql: string): AsyncStatement<Row, Params> {
        const stmt = this.db.prepare(sql) as Statement
        return {
            get: async (...params) => stmt.get(...params as Parameters<Statement['get']>) as Row | undefined,
            all: async (...params) => stmt.all(...params as Parameters<Statement['get']>) as Row[],
            run: async (...params) => stmt.run(...params as Parameters<Statement['get']>),
            iterate: async function* (...params) { yield* stmt.iterate(...params as Parameters<Statement['get']>) as Iterable<Row> },
            finalize: () => stmt.finalize()
        }
    }
    async exec(sql: string): Promise<void> { this.db.exec(sql) }
    operation<T>(callback: () => Promise<T>, write: boolean): Promise<T> {
        if (this.context.getStore()) return callback()
        const result = this.tail.then(() => this.context.run(true, async () => {
            if (!write) return callback()
            this.db.exec('BEGIN IMMEDIATE')
            try {
                const value = await callback()
                this.db.exec('COMMIT')
                return value
            } catch (error) {
                this.db.exec('ROLLBACK')
                throw error
            }
        }))
        this.tail = result.catch(() => undefined)
        return result
    }
    transaction<T>(callback: () => Promise<T>): () => Promise<T> {
        return async () => {
            if (!this.context.getStore()) return this.operation(callback, true)
            const name = `hapi_${++this.savepoint}`
            this.db.exec(`SAVEPOINT ${name}`)
            try {
                const value = await callback()
                this.db.exec(`RELEASE SAVEPOINT ${name}`)
                return value
            } catch (error) {
                this.db.exec(`ROLLBACK TO SAVEPOINT ${name}`)
                this.db.exec(`RELEASE SAVEPOINT ${name}`)
                throw error
            }
        }
    }
    async close(): Promise<void> { await this.tail; this.db.close() }
}

/** Translate the small SQL dialect shared by the existing storage helpers. */
export function postgresQuery(source: string, params: unknown[]): { sql: string; values: unknown[] } {
    let sql = source.replace(/INDEXED BY idx_messages_scheduled_pending/g, '')
        .replace(/\browid\b/g, 'insertion_order')
        .replace(/MAX\(usage_scan_state\.last_seq, excluded\.last_seq\)/g, 'GREATEST(usage_scan_state.last_seq, excluded.last_seq)')
        .replace(/\bAS (nextSeq|maxSeq)\b/g, 'AS "$1"')
        .replace(/SELECT (id, )?content FROM messages/g, 'SELECT $1content, content_encoding FROM messages')
    const ignore = /INSERT OR IGNORE/i.test(sql)
    sql = sql.replace(/INSERT OR IGNORE/gi, 'INSERT')
    if (ignore) sql = sql.trim().replace(/;$/, '') + ' ON CONFLICT DO NOTHING'
    const values: unknown[] = []
    const named = params.length === 1 && params[0] !== null && typeof params[0] === 'object' && !ArrayBuffer.isView(params[0])
        ? params[0] as Record<string, unknown> : undefined
    let position = 0
    // Quoted literals and comments are preserved; only actual bind tokens change.
    sql = sql.replace(/'(?:''|[^'])*'|--[^\n]*|@[a-zA-Z_]\w*|\?/g, token => {
        if (token[0] === "'" || token.startsWith('--')) return token
        let value = token === '?' ? params[position++] : named?.[token.slice(1)]
        if (value === undefined) throw new Error(`Missing SQL binding ${token}`)
        if (typeof value === 'string' && (token === '@content' || (token === '?' && position === 1 && /UPDATE messages SET content\s*=/.test(source)))) {
            value = Buffer.from(value, 'utf8')
        }
        values.push(value)
        return `$${values.length}`
    })
    return { sql, values }
}

function safeRow(row: Record<string, unknown>): Record<string, unknown> {
    for (const [key, value] of Object.entries(row)) {
        if (typeof value === 'bigint') {
            const number = Number(value)
            if (!Number.isSafeInteger(number)) throw new Error(`PostgreSQL integer outside JavaScript safe range: ${key}`)
            row[key] = number
        }
    }
    if ('content_encoding' in row && 'content' in row) {
        if (row.content_encoding === 'json') row.content = Buffer.from(row.content as Uint8Array).toString('utf8')
        else if (row.content_encoding !== 'zstd') throw new Error('Unknown message content encoding')
    }
    return row
}

export class PostgresDatabase implements Database {
    readonly backend = 'postgres' as const
    readonly sql: SQL
    private readonly context = new AsyncLocalStorage<TransactionSQL>()
    private writeTail: Promise<unknown> = Promise.resolve()
    private cursorId = 0
    constructor(url: string) {
        if (!['postgres:', 'postgresql:'].includes(new URL(url).protocol)) throw new Error('DATABASE_URL must use PostgreSQL')
        this.sql = new SQL(url, { max: 8, connectionTimeout: 10, bigint: true })
    }
    prepare<Row = unknown, Params extends unknown[] = unknown[]>(source: string): AsyncStatement<Row, Params> {
        const database = this
        const execute = async (params: Params) => {
            const query = postgresQuery(source, params)
            const result = await (this.context.getStore() ?? this.sql).unsafe(query.sql, query.values)
            return result
        }
        return {
            get: async (...params) => {
                const rows = await execute(params)
                return rows[0] ? safeRow(rows[0]) as Row : undefined
            },
            all: async (...params) => (await execute(params)).map((row: Record<string, unknown>) => safeRow(row)) as Row[],
            run: async (...params) => ({ changes: (await execute(params)).count }),
            iterate: async function* (...params) {
                const transaction = database.context.getStore()
                const reserved = transaction ? undefined : await database.sql.reserve()
                const client = transaction ?? reserved!
                const cursor = `hapi_read_${++database.cursorId}`
                const query = postgresQuery(source, params)
                let declared = false
                try {
                    if (reserved) await reserved.unsafe('BEGIN READ ONLY')
                    await client.unsafe(`DECLARE ${cursor} NO SCROLL CURSOR FOR ${query.sql}`, query.values)
                    declared = true
                    while (true) {
                        const rows = await client.unsafe(`FETCH FORWARD 100 FROM ${cursor}`)
                        if (!rows.length) break
                        for (const row of rows) yield safeRow(row) as Row
                    }
                } finally {
                    try { if (declared) await client.unsafe(`CLOSE ${cursor}`) }
                    finally {
                        if (reserved) {
                            try { await reserved.unsafe('ROLLBACK') }
                            finally { reserved.release() }
                        }
                    }
                }
            },
            finalize: () => {}
        }
    }
    async exec(source: string): Promise<void> { await (this.context.getStore() ?? this.sql).unsafe(source) }
    operation<T>(callback: () => Promise<T>, write: boolean): Promise<T> {
        if (this.context.getStore() || !write) return callback()
        const result = this.writeTail.then(() => this.sql.begin(async tx => {
            // Preserve SQLite's single-writer semantics across Hub processes.
            await tx`SELECT pg_advisory_xact_lock(48415049)`
            return this.context.run(tx, callback)
        })) as Promise<T>
        this.writeTail = result.catch(() => undefined)
        return result
    }
    transaction<T>(callback: () => Promise<T>): () => Promise<T> {
        return async () => {
            const tx = this.context.getStore()
            return tx ? tx.savepoint(() => callback()) as Promise<T> : this.operation(callback, true)
        }
    }
    async close(): Promise<void> { await this.writeTail; await this.sql.close() }
}
