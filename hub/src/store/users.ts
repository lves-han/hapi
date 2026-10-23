import type { Database } from './database'

import type { StoredUser } from './types'

type DbUserRow = {
    id: number
    platform: string
    platform_user_id: string
    namespace: string
    created_at: number
}

function toStoredUser(row: DbUserRow): StoredUser {
    return {
        id: row.id,
        platform: row.platform,
        platformUserId: row.platform_user_id,
        namespace: row.namespace,
        createdAt: row.created_at
    }
}

export async function getUser(db: Database, platform: string, platformUserId: string): Promise<StoredUser | null> {
    const row = (await db.prepare(
        'SELECT * FROM users WHERE platform = ? AND platform_user_id = ? LIMIT 1'
    ).get(platform, platformUserId)) as DbUserRow | undefined
    return row ? toStoredUser(row) : null
}

export async function getUsersByPlatform(db: Database, platform: string): Promise<StoredUser[]> {
    const rows = (await db.prepare(
        'SELECT * FROM users WHERE platform = ? ORDER BY created_at ASC'
    ).all(platform)) as DbUserRow[]
    return rows.map(toStoredUser)
}

export async function getUsersByPlatformAndNamespace(
    db: Database,
    platform: string,
    namespace: string
): Promise<StoredUser[]> {
    const rows = (await db.prepare(
        'SELECT * FROM users WHERE platform = ? AND namespace = ? ORDER BY created_at ASC'
    ).all(platform, namespace)) as DbUserRow[]
    return rows.map(toStoredUser)
}

export async function addUser(
    db: Database,
    platform: string,
    platformUserId: string,
    namespace: string
): Promise<StoredUser> {
    const now = Date.now()
    await db.prepare(`
        INSERT OR IGNORE INTO users (
            platform, platform_user_id, namespace, created_at
        ) VALUES (
            @platform, @platform_user_id, @namespace, @created_at
        )
    `).run({
        platform,
        platform_user_id: platformUserId,
        namespace,
        created_at: now
    })

    const row = (await getUser(db, platform, platformUserId))
    if (!row) {
        throw new Error('Failed to create user')
    }
    return row
}

export async function removeUser(db: Database, platform: string, platformUserId: string): Promise<boolean> {
    const result = (await db.prepare(
        'DELETE FROM users WHERE platform = ? AND platform_user_id = ?'
    ).run(platform, platformUserId))
    return result.changes > 0
}
