import type { Database } from './database'

import type { StoredPushSubscription } from './types'

type DbPushSubscriptionRow = {
    id: number
    namespace: string
    endpoint: string
    p256dh: string
    auth: string
    created_at: number
}

function toStoredPushSubscription(row: DbPushSubscriptionRow): StoredPushSubscription {
    return {
        id: row.id,
        namespace: row.namespace,
        endpoint: row.endpoint,
        p256dh: row.p256dh,
        auth: row.auth,
        createdAt: row.created_at
    }
}

export async function addPushSubscription(
    db: Database,
    namespace: string,
    subscription: { endpoint: string; p256dh: string; auth: string }
): Promise<void> {
    const now = Date.now()
    await db.prepare(`
        INSERT INTO push_subscriptions (
            namespace, endpoint, p256dh, auth, created_at
        ) VALUES (
            @namespace, @endpoint, @p256dh, @auth, @created_at
        )
        ON CONFLICT(namespace, endpoint)
        DO UPDATE SET
            p256dh = excluded.p256dh,
            auth = excluded.auth,
            created_at = excluded.created_at
    `).run({
        namespace,
        endpoint: subscription.endpoint,
        p256dh: subscription.p256dh,
        auth: subscription.auth,
        created_at: now
    })
}

export async function removePushSubscription(db: Database, namespace: string, endpoint: string): Promise<void> {
    await db.prepare(
        'DELETE FROM push_subscriptions WHERE namespace = ? AND endpoint = ?'
    ).run(namespace, endpoint)
}

export async function getPushSubscriptionsByNamespace(
    db: Database,
    namespace: string
): Promise<StoredPushSubscription[]> {
    const rows = (await db.prepare(
        'SELECT * FROM push_subscriptions WHERE namespace = ? ORDER BY created_at DESC'
    ).all(namespace)) as DbPushSubscriptionRow[]
    return rows.map(toStoredPushSubscription)
}
