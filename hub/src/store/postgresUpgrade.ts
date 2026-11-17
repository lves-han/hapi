import type { TransactionSQL } from 'bun'
import { extractInjectedTurnUuid, extractMessageRenderKey, isLiveStreamSnapshot } from '@hapi/protocol/messages'
import { decodeMessageContent } from './contentCodec'
import { PostgresDatabase } from './database'
import { postgresSearchEntry, postgresSearchSchema, type PostgresSearchEntry } from './messageContentSearchRuntime'
import { postgresSchemaVersion } from './postgresSchema'
import { isUserInputMessage } from './sessionUserActivity'

type MessageRow = {
    id: string
    session_id: string
    content: string | Uint8Array
    created_at: number
    seq: number
    invoked_at: number | null
}

export async function createPostgresSearchSchema(tx: TransactionSQL): Promise<void> {
    for (const statement of postgresSearchSchema) await tx.unsafe(statement)
}

/** Rebuild derived state inside the same transaction as the schema upgrade. */
export async function backfillPostgresMessageState(db: PostgresDatabase, tx: TransactionSQL, backfillUserActivity: boolean): Promise<void> {
    await db.withTransaction(tx, async () => {
        const latest = new Map<string, number>()
        const injectedTurnUuids = new Set<string>()
        const statement = db.prepare<MessageRow>('SELECT * FROM messages ORDER BY insertion_order')
        try {
            for await (const row of statement.iterate()) {
                const content = decodeMessageContent(row.content)
                const uuid = extractInjectedTurnUuid(content)
                if (uuid) injectedTurnUuids.add(uuid)
                if (backfillUserActivity && isUserInputMessage(content)) {
                    latest.set(row.session_id, Math.max(latest.get(row.session_id) ?? -Infinity, row.created_at))
                }
            }
        } finally {
            statement.finalize()
        }
        const batch = new Map<string, PostgresSearchEntry | null>()
        const flush = async () => {
            if (!batch.size) return
            const keys = [...batch.keys()]
            await tx.unsafe(`DELETE FROM hapi_message_content_search WHERE search_key IN (${keys.map((_, i) => `$${i + 1}`).join(',')})`, keys)
            const entries = [...batch.values()].filter((entry): entry is PostgresSearchEntry => entry !== null)
            if (entries.length) {
                const values: unknown[] = []
                const tuples = entries.map(entry => {
                    const fields = [entry.searchKey, entry.targetMessageId, entry.sessionId, entry.seq, entry.createdAt,
                        entry.role, entry.text, entry.folded, entry.shortFolded, entry.truncated, entry.shortTruncated]
                    return `(${fields.map(value => { values.push(value); return `$${values.length}` }).join(',')})`
                })
                await tx.unsafe(`INSERT INTO hapi_message_content_search
                    (search_key, target_message_id, session_id, seq, created_at, role, searchable_text,
                     folded_text, short_folded_text, is_truncated, short_index_truncated)
                    VALUES ${tuples.join(',')}`, values)
            }
            batch.clear()
        }
        const indexSource = db.prepare<MessageRow>('SELECT * FROM messages WHERE invoked_at IS NOT NULL ORDER BY insertion_order')
        try {
            for await (const row of indexSource.iterate()) {
                const content = decodeMessageContent(row.content)
                if (isLiveStreamSnapshot(content)) continue
                const renderKey = extractMessageRenderKey(content)
                const key = renderKey ? `${row.session_id}:${renderKey}` : row.id
                batch.set(key, postgresSearchEntry({ id: row.id, sessionId: row.session_id, content, seq: row.seq,
                    createdAt: row.created_at, invokedAt: row.invoked_at }, injectedTurnUuids))
                if (batch.size >= 250) await flush()
            }
            await flush()
        } finally {
            indexSource.finalize()
        }
        for (const [sessionId, at] of latest) {
            await db.prepare('UPDATE sessions SET last_user_message_at = ? WHERE id = ?').run(at, sessionId)
        }
    })
}

async function upgradePostgres26To31(
    db: PostgresDatabase,
    tx: TransactionSQL,
    schema: { tables: string[]; indexes: string[] }
): Promise<void> {
    await tx.unsafe('ALTER TABLE sessions ADD COLUMN last_user_message_at BIGINT')
    for (const column of ['content_revision', 'read_revision', 'read_state_version', 'manual_unread']) {
        await tx.unsafe(`ALTER TABLE sessions ADD COLUMN ${column} BIGINT NOT NULL DEFAULT 0`)
    }
    await tx.unsafe('ALTER TABLE messages ADD COLUMN content_revision BIGINT NOT NULL DEFAULT 0')
    const turns = schema.tables.find(statement => /^CREATE TABLE (?:IF NOT EXISTS )?session_turns\s*\(/i.test(statement))
    if (!turns) throw new Error('Canonical session_turns schema is missing')
    await tx.unsafe(turns)
    for (const statement of schema.indexes) {
        if (/idx_session_turns_|idx_messages_future_scheduled_queued/.test(statement)) await tx.unsafe(statement)
    }
    await createPostgresSearchSchema(tx)
    await backfillPostgresMessageState(db, tx, true)
    await tx.unsafe('UPDATE hapi_store_metadata SET schema_version = 31 WHERE id = 1 AND schema_version = 26')
}

async function upgradePostgres31To36(
    tx: TransactionSQL,
    schema: { tables: string[]; indexes: string[] }
): Promise<void> {
    for (const table of ['session_jobs', 'session_redirects', 'passkey_credentials']) {
        const ddl = schema.tables.find(statement => new RegExp(`^CREATE TABLE (?:IF NOT EXISTS )?${table}\\s*\\(`, 'i').test(statement))
        if (!ddl) throw new Error(`Canonical ${table} schema is missing`)
        await tx.unsafe(ddl)
    }
    for (const statement of schema.indexes) {
        if (/idx_session_jobs_|idx_session_redirects_|idx_passkey_credentials_/.test(statement)) {
            await tx.unsafe(statement)
        }
    }
    await tx.unsafe('ALTER TABLE usage_scan_state ADD COLUMN parser_version BIGINT NOT NULL DEFAULT 2')
    await tx.unsafe('DELETE FROM usage_scan_state')
    await tx.unsafe(`UPDATE hapi_store_metadata SET schema_version = ${postgresSchemaVersion} WHERE id = 1 AND schema_version = 31`)
}

export async function upgradePostgresSchema(
    db: PostgresDatabase,
    tx: TransactionSQL,
    fromVersion: number,
    schema: { tables: string[]; indexes: string[] }
): Promise<void> {
    if (fromVersion === 26) {
        await upgradePostgres26To31(db, tx, schema)
        await upgradePostgres31To36(tx, schema)
        return
    }
    if (fromVersion === 31) {
        await upgradePostgres31To36(tx, schema)
        return
    }
    throw new Error(`Unsupported PostgreSQL upgrade source schema: ${fromVersion}`)
}
