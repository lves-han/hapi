import {
    extractAssistantParentUuid,
    extractInjectedTurnUuid,
    extractMessageRenderKey,
    extractSearchableMessageText,
    isLiveStreamSnapshot,
    unwrapRoleWrappedRecordEnvelope
} from '@hapi/protocol/messages'
import { SQLiteDatabase, type Database } from './database'
import { decodeMessageContent } from './contentCodec'
import {
    MAX_INDEXED_MESSAGE_CHARACTERS,
    MAX_SHORT_SEARCH_TEXT_CHARACTERS,
    hasPotentiallyIncompleteMessageContent as sqliteHasIncomplete,
    indexMessageContent as sqliteIndex,
    invalidateMessageContentSearchInjectedTurnCache as sqliteInvalidate,
    rebuildMessageContentSearchForSessions as sqliteRebuild,
    removeMessageContentSearchForSession as sqliteRemoveSession,
    removeMessageContentSearchIndex as sqliteRemove,
    searchMessageContent as sqliteSearch,
    searchMessageContentInSession as sqliteSearchSession,
    serializeContentSearchSessionIds,
    type MessageContentSearchMatch,
    type SessionMessageContentSearchResult
} from './messageContentSearch'

export type IndexableMessage = {
    id: string
    sessionId: string
    content: unknown
    seq: number
    createdAt: number
    invokedAt: number | null
}

export type PostgresSearchEntry = {
    searchKey: string
    targetMessageId: string
    sessionId: string
    seq: number
    createdAt: number
    role: 'user' | 'assistant'
    text: string
    folded: string
    shortFolded: string
    truncated: number
    shortTruncated: number
}

type SearchRow = {
    target_message_id: string
    session_id: string
    role: 'user' | 'assistant'
    seq: number
    created_at: number
    searchable_text: string
    is_truncated: number
    short_index_truncated: number
}

/** PostgreSQL's search rows are derived data and can be rebuilt from messages. */
export const postgresSearchSchema = [ `
    CREATE TABLE IF NOT EXISTS hapi_message_content_search (
        search_key TEXT PRIMARY KEY,
        target_message_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        role TEXT NOT NULL,
        searchable_text TEXT NOT NULL,
        folded_text TEXT NOT NULL,
        short_folded_text TEXT NOT NULL,
        is_truncated BIGINT NOT NULL,
        short_index_truncated BIGINT NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_hapi_message_search_session ON hapi_message_content_search(session_id)',
    'CREATE INDEX IF NOT EXISTS idx_hapi_message_search_target ON hapi_message_content_search(target_message_id)'
]

function boundText(text: string, limit: number): string {
    if (text.length <= limit) return text
    const headSize = Math.floor((limit - 1) / 2)
    let head = text.slice(0, headSize)
    let tail = text.slice(text.length - (limit - 1 - headSize))
    if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1)
    if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1)
    return `${head} ${tail}`
}

function normalizeQuery(query: string): string {
    return query.trim().replace(/\s+/g, ' ')
}

function normalizedScope(sessionIds?: readonly string[]): string[] | undefined | null {
    if (sessionIds === undefined) return undefined
    const unique = [...new Set(sessionIds.map(id => id.trim()).filter(Boolean))]
    if (!unique.length || serializeContentSearchSessionIds(unique) === null) return null
    return unique
}

function scopeSql(scope: string[] | undefined): string {
    return scope ? ` AND f.session_id IN (${scope.map(() => '?').join(', ')})` : ''
}

function snippet(text: string, query: string): string {
    const position = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
    const start = Math.max(0, position - 90)
    const end = Math.min(text.length, Math.max(0, position) + query.length + 90)
    return `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`.replace(/\s+/g, ' ').trim()
}

function toMatch(row: SearchRow, query: string): MessageContentSearchMatch {
    return {
        sessionId: row.session_id,
        messageId: row.target_message_id,
        role: row.role,
        seq: row.seq,
        createdAt: row.created_at,
        snippet: snippet(row.searchable_text, query),
        truncated: row.is_truncated === 1 || ([...query].length === 2 && row.short_index_truncated === 1)
    }
}

export function postgresSearchEntry(message: IndexableMessage, injectedTurnUuids?: ReadonlySet<string>): PostgresSearchEntry | null {
    if (message.invokedAt === null || isLiveStreamSnapshot(message.content)) return null
    const searchable = extractSearchableMessageText(message.content, {
        maxSourceCharacters: MAX_INDEXED_MESSAGE_CHARACTERS,
        ...(injectedTurnUuids ? { injectedTurnUuids } : {})
    })
    if (!searchable) return null
    const renderKey = extractMessageRenderKey(message.content)
    // PostgreSQL text cannot contain NUL; message content itself remains unchanged.
    const clean = Buffer.from(searchable.text, 'utf8').toString('utf8').replaceAll('\0', ' ')
    const text = boundText(clean, MAX_INDEXED_MESSAGE_CHARACTERS)
    const short = boundText(text, MAX_SHORT_SEARCH_TEXT_CHARACTERS)
    return { searchKey: renderKey ? `${message.sessionId}:${renderKey}` : message.id,
        targetMessageId: message.id, sessionId: message.sessionId, seq: message.seq, createdAt: message.createdAt,
        role: searchable.role, text, folded: text.toLocaleLowerCase(), shortFolded: short.toLocaleLowerCase(),
        truncated: searchable.truncated || text !== clean ? 1 : 0, shortTruncated: short !== text ? 1 : 0 }
}

export async function indexMessageContent(db: Database, message: IndexableMessage): Promise<void> {
    if (db instanceof SQLiteDatabase) {
        sqliteIndex(db.sqliteDatabase, message)
        return
    }
    if (isLiveStreamSnapshot(message.content)) return
    const renderKey = extractMessageRenderKey(message.content)
    const searchKey = renderKey ? `${message.sessionId}:${renderKey}` : message.id
    await db.prepare('DELETE FROM hapi_message_content_search WHERE target_message_id = ? OR search_key = ?')
        .run(message.id, searchKey)
    if (message.invokedAt === null) return

    const searchable = extractSearchableMessageText(message.content, { maxSourceCharacters: MAX_INDEXED_MESSAGE_CHARACTERS })
    const record = unwrapRoleWrappedRecordEnvelope(message.content)
    let injectedTurnUuids: Set<string> | undefined
    if (extractAssistantParentUuid(record?.content) && searchable?.role === 'assistant'
        && ['No response requested.', 'No response requested'].includes(searchable.text.trim())) {
        const rows = await db.prepare<{ content: string | Uint8Array }>(
            'SELECT content FROM messages WHERE session_id = ?'
        ).all(message.sessionId)
        injectedTurnUuids = new Set(rows.map(row => extractInjectedTurnUuid(decodeMessageContent(row.content))).filter((id): id is string => Boolean(id)))
    }
    const entry = postgresSearchEntry(message, injectedTurnUuids)
    if (!entry) return
    await db.prepare(`
        INSERT INTO hapi_message_content_search
            (search_key, target_message_id, session_id, seq, created_at, role, searchable_text,
             folded_text, short_folded_text, is_truncated, short_index_truncated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(entry.searchKey, entry.targetMessageId, entry.sessionId, entry.seq, entry.createdAt, entry.role,
        entry.text, entry.folded, entry.shortFolded, entry.truncated, entry.shortTruncated)
}

export async function removeMessageContentSearchIndex(db: Database, messageId: string): Promise<void> {
    if (db instanceof SQLiteDatabase) return sqliteRemove(db.sqliteDatabase, messageId)
    await db.prepare('DELETE FROM hapi_message_content_search WHERE target_message_id = ? OR search_key = ?').run(messageId, messageId)
}

export async function removeMessageContentSearchForSession(db: Database, sessionId: string): Promise<void> {
    if (db instanceof SQLiteDatabase) return sqliteRemoveSession(db.sqliteDatabase, sessionId)
    await db.prepare('DELETE FROM hapi_message_content_search WHERE session_id = ?').run(sessionId)
}

export async function invalidateMessageContentSearchInjectedTurnCache(db: Database, sessionIds: readonly string[]): Promise<void> {
    if (db instanceof SQLiteDatabase) sqliteInvalidate(db.sqliteDatabase, sessionIds)
}

export async function rebuildMessageContentSearchForSessions(db: Database, sessionIds: string[], inTransaction = false): Promise<void> {
    if (db instanceof SQLiteDatabase) return sqliteRebuild(db.sqliteDatabase, sessionIds, inTransaction)
    for (const sessionId of sessionIds) {
        await removeMessageContentSearchForSession(db, sessionId)
        const rows = await db.prepare<{ id: string; session_id: string; content: string | Uint8Array; seq: number; created_at: number; invoked_at: number | null }>(
            'SELECT id, session_id, content, content_encoding, seq, created_at, invoked_at FROM messages WHERE session_id = ? ORDER BY insertion_order'
        ).all(sessionId)
        for (const row of rows) {
            await indexMessageContent(db, { id: row.id, sessionId, content: decodeMessageContent(row.content), seq: row.seq, createdAt: row.created_at, invokedAt: row.invoked_at })
        }
    }
}

export async function hasPotentiallyIncompleteMessageContent(db: Database, namespace: string, query: string, sessionIds?: readonly string[]): Promise<boolean> {
    if (db instanceof SQLiteDatabase) return sqliteHasIncomplete(db.sqliteDatabase, namespace, query, sessionIds)
    const normalized = normalizeQuery(query)
    const scope = normalizedScope(sessionIds)
    if ([...normalized].length < 2 || scope === null) return false
    const row = await db.prepare<{ found: number }>(`
        SELECT 1 AS found FROM hapi_message_content_search f
        JOIN sessions s ON s.id = f.session_id AND s.namespace = ?
        WHERE (f.is_truncated = 1 OR (? = 2 AND f.short_index_truncated = 1))${scopeSql(scope)} LIMIT 1
    `).get(namespace, [...normalized].length, ...(scope ?? []))
    return Boolean(row)
}

export async function searchMessageContent(db: Database, query: string, namespace: string, limit = 50, sessionIds?: readonly string[]): Promise<MessageContentSearchMatch[]> {
    if (db instanceof SQLiteDatabase) return sqliteSearch(db.sqliteDatabase, query, namespace, limit, sessionIds)
    const normalized = normalizeQuery(query)
    const scope = normalizedScope(sessionIds)
    if ([...normalized].length < 2 || scope === null) return []
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 50
    const textColumn = [...normalized].length === 2 ? 'short_folded_text' : 'folded_text'
    const rows = await db.prepare<SearchRow>(`
        WITH ranked AS (
            SELECT f.*, s.updated_at, ROW_NUMBER() OVER (PARTITION BY f.session_id ORDER BY f.seq DESC, f.created_at DESC, f.target_message_id DESC) AS session_rank
            FROM hapi_message_content_search f JOIN sessions s ON s.id = f.session_id AND s.namespace = ?
            WHERE strpos(f.${textColumn}, ?) > 0${scopeSql(scope)}
        ) SELECT * FROM ranked WHERE session_rank = 1 ORDER BY updated_at DESC, seq DESC LIMIT ?
    `).all(namespace, normalized.toLocaleLowerCase(), ...(scope ?? []), safeLimit)
    return rows.map(row => toMatch(row, normalized))
}

export async function searchMessageContentInSession(db: Database, query: string, namespace: string, sessionId: string, limit = 500): Promise<SessionMessageContentSearchResult> {
    if (db instanceof SQLiteDatabase) return sqliteSearchSession(db.sqliteDatabase, query, namespace, sessionId, limit)
    const normalized = normalizeQuery(query)
    if ([...normalized].length < 2) return { matches: [], total: 0, hasPotentiallyIncompleteResults: false }
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.floor(limit))) : 500
    const column = [...normalized].length === 2 ? 'short_folded_text' : 'folded_text'
    const args = [namespace, sessionId, normalized.toLocaleLowerCase()]
    const from = `FROM hapi_message_content_search f JOIN sessions s ON s.id = f.session_id AND s.namespace = ? WHERE f.session_id = ? AND strpos(f.${column}, ?) > 0`
    const count = await db.prepare<{ count: number }>(`SELECT COUNT(*) AS count ${from}`).get(...args)
    const rows = await db.prepare<SearchRow>(`SELECT f.* ${from} ORDER BY f.seq DESC LIMIT ?`).all(...args, safeLimit)
    return { matches: rows.map(row => toMatch(row, normalized)), total: count?.count ?? 0,
        hasPotentiallyIncompleteResults: await hasPotentiallyIncompleteMessageContent(db, namespace, normalized, [sessionId]) }
}
