import type { Database } from './database'

const MAX_REDIRECT_HOPS = 32

/**
 * Durable `old session id → surviving session id` pointers written when a
 * merge deletes a session row. Lets links, peer references and `--existing-
 * session-id` reopens of a merged-away id keep resolving after the row is gone.
 *
 * Rows are path-compressed on write (every pointer targets a live row at the
 * time it is written), so resolution is normally a single hop.
 */
export class SessionRedirectStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    /** Record that `oldId` was merged into `newId` (both in `namespace`). */
    async record(oldId: string, newId: string, namespace: string, now: number = Date.now()): Promise<void> {
        if (oldId === newId) return
        await this.db.operation(() => this.db.transaction(async () => {
            // Anything that pointed at the row being removed now points at the survivor.
            await this.db.prepare(
                'UPDATE session_redirects SET new_id = ? WHERE new_id = ? AND namespace = ?'
            ).run(newId, oldId, namespace)
            // The survivor is a live row; a stale pointer away from it would be
            // shadowed anyway, and could form a cycle if it is merged back later.
            await this.db.prepare(
                'DELETE FROM session_redirects WHERE old_id = ? AND namespace = ?'
            ).run(newId, namespace)
            await this.db.prepare(`
                INSERT INTO session_redirects (old_id, new_id, namespace, created_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(old_id) DO UPDATE SET
                    new_id = excluded.new_id,
                    namespace = excluded.namespace,
                    created_at = excluded.created_at
            `).run(oldId, newId, namespace, now)
        })(), true)
    }

    /**
     * Follow redirects from `sessionId` within `namespace`. Returns the final
     * target id, or null when `sessionId` has no redirect in this namespace.
     * The caller still has to check that the returned row exists.
     */
    async resolve(sessionId: string, namespace: string): Promise<string | null> {
        return this.db.operation(async () => {
            const stmt = this.db.prepare<{ new_id: string }, [string, string]>(
                'SELECT new_id FROM session_redirects WHERE old_id = ? AND namespace = ?'
            )
            try {
                let current = sessionId
                let resolved: string | null = null
                const visited = new Set<string>([sessionId])
                for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop += 1) {
                    const row = await stmt.get(current, namespace)
                    if (!row || visited.has(row.new_id)) break
                    visited.add(row.new_id)
                    current = row.new_id
                    resolved = current
                }
                return resolved
            } finally {
                stmt.finalize()
            }
        }, false)
    }

    /** Drop redirects that lead to `sessionId` (used when that session is deleted for good). */
    async deleteTargeting(sessionId: string, namespace: string): Promise<void> {
        await this.db.operation(async () => {
            await this.db.prepare(
                'DELETE FROM session_redirects WHERE new_id = ? AND namespace = ?'
            ).run(sessionId, namespace)
        }, true)
    }
}
