import type { Database } from './database'

export const PASSKEY_CREDENTIALS_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS passkey_credentials (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        rp_id TEXT NOT NULL,
        public_key BLOB NOT NULL,
        counter INTEGER NOT NULL DEFAULT 0,
        transports TEXT,
        token_fingerprint TEXT NOT NULL,
        name TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_passkey_credentials_namespace
        ON passkey_credentials(namespace, created_at);
`

export type StoredPasskeyCredential = {
    id: string
    namespace: string
    rpId: string
    publicKey: Uint8Array<ArrayBuffer>
    counter: number
    transports: string[]
    /** HMAC of the CLI access token that was current when the passkey was registered. */
    tokenFingerprint: string
    name: string | null
    createdAt: number
    lastUsedAt: number | null
}

type DbPasskeyRow = {
    id: string
    namespace: string
    rp_id: string
    public_key: Uint8Array
    counter: number
    transports: string | null
    token_fingerprint: string
    name: string | null
    created_at: number
    last_used_at: number | null
}

function parseTransports(raw: string | null): string[] {
    if (!raw) return []
    try {
        const parsed: unknown = JSON.parse(raw)
        return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : []
    } catch {
        return []
    }
}

function toStored(row: DbPasskeyRow): StoredPasskeyCredential {
    return {
        id: row.id,
        namespace: row.namespace,
        rpId: row.rp_id,
        publicKey: new Uint8Array(row.public_key),
        counter: row.counter,
        transports: parseTransports(row.transports),
        tokenFingerprint: row.token_fingerprint,
        name: row.name,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at
    }
}

/**
 * WebAuthn credentials that can be exchanged for a web JWT. Each credential is
 * bound to the namespace and CLI access token that registered it.
 */
export class PasskeyStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    async add(credential: Omit<StoredPasskeyCredential, 'lastUsedAt'>): Promise<void> {
        await this.db.operation(async () => {
            await this.db.prepare(`
                INSERT INTO passkey_credentials (
                    id, namespace, rp_id, public_key, counter, transports,
                    token_fingerprint, name, created_at, last_used_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
            `).run(
                credential.id,
                credential.namespace,
                credential.rpId,
                credential.publicKey,
                credential.counter,
                JSON.stringify(credential.transports),
                credential.tokenFingerprint,
                credential.name,
                credential.createdAt
            )
        }, true)
    }

    async get(id: string): Promise<StoredPasskeyCredential | null> {
        return this.db.operation(async () => {
            const row = await this.db.prepare<DbPasskeyRow>(
                'SELECT * FROM passkey_credentials WHERE id = ? LIMIT 1'
            ).get(id)
            return row ? toStored(row) : null
        }, false)
    }

    async listByNamespace(namespace: string): Promise<StoredPasskeyCredential[]> {
        return this.db.operation(async () => {
            const rows = await this.db.prepare<DbPasskeyRow>(
                'SELECT * FROM passkey_credentials WHERE namespace = ? ORDER BY created_at ASC'
            ).all(namespace)
            return rows.map(toStored)
        }, false)
    }

    async listByRpId(rpId: string): Promise<StoredPasskeyCredential[]> {
        return this.db.operation(async () => {
            const rows = await this.db.prepare<DbPasskeyRow>(
                'SELECT * FROM passkey_credentials WHERE rp_id = ? ORDER BY created_at ASC'
            ).all(rpId)
            return rows.map(toStored)
        }, false)
    }

    async recordUse(id: string, counter: number, usedAt: number): Promise<void> {
        await this.db.operation(async () => {
            await this.db.prepare(
                'UPDATE passkey_credentials SET counter = ?, last_used_at = ? WHERE id = ?'
            ).run(counter, usedAt, id)
        }, true)
    }

    async remove(id: string, namespace: string): Promise<boolean> {
        return this.db.operation(async () => {
            const result = await this.db.prepare(
                'DELETE FROM passkey_credentials WHERE id = ? AND namespace = ?'
            ).run(id, namespace)
            return result.changes > 0
        }, true)
    }
}
