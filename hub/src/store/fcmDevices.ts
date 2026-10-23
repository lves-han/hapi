import type { Database } from './database'

import type { NativeDevicePlatform, StoredFcmDevice } from './types'

type DbFcmDeviceRow = {
    id: number
    namespace: string
    token: string
    platform: string
    device_id: string
    push_key: string | null
    created_at: number
    updated_at: number
}

function toStoredFcmDevice(row: DbFcmDeviceRow): StoredFcmDevice {
    return {
        id: row.id,
        namespace: row.namespace,
        token: row.token,
        platform: row.platform as StoredFcmDevice['platform'],
        deviceId: row.device_id,
        pushKey: row.push_key,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    }
}

export async function upsertFcmDevice(
    db: Database,
    namespace: string,
    device: { token: string; platform: NativeDevicePlatform; deviceId: string; pushKey?: string }
): Promise<void> {
    const now = Date.now()
    const params = {
        namespace,
        token: device.token,
        platform: device.platform,
        device_id: device.deviceId,
        push_key: device.pushKey ?? null,
        created_at: now,
        updated_at: now
    }

    await db.transaction(async () => {
        // One push token must not deliver across namespaces. Re-pairing the
        // same native install under a new namespace drops stale rows that
        // still reference this token elsewhere.
        await db.prepare(`
            DELETE FROM fcm_devices
            WHERE token = @token
              AND (namespace != @namespace OR device_id != @device_id OR platform != @platform)
        `).run(params)

        await db.prepare(`
            INSERT INTO fcm_devices (
                namespace, token, platform, device_id, push_key, created_at, updated_at
            ) VALUES (
                @namespace, @token, @platform, @device_id, @push_key, @created_at, @updated_at
            )
            ON CONFLICT(namespace, device_id, platform)
            DO UPDATE SET
                token = excluded.token,
                push_key = excluded.push_key,
                updated_at = excluded.updated_at
        `).run(params)
    })()
}

export async function removeFcmDeviceByToken(db: Database, namespace: string, token: string): Promise<void> {
    await db.prepare('DELETE FROM fcm_devices WHERE namespace = ? AND token = ?').run(namespace, token)
}

export async function getFcmDevicesByNamespace(
    db: Database,
    namespace: string,
    platforms?: readonly NativeDevicePlatform[]
): Promise<StoredFcmDevice[]> {
    if (platforms && platforms.length > 0) {
        const placeholders = platforms.map(() => '?').join(', ')
        const rows = (await db.prepare(
            `SELECT * FROM fcm_devices WHERE namespace = ? AND platform IN (${placeholders}) ORDER BY updated_at DESC`
        ).all(namespace, ...platforms)) as DbFcmDeviceRow[]
        return rows.map(toStoredFcmDevice)
    }
    const rows = (await db.prepare(
        'SELECT * FROM fcm_devices WHERE namespace = ? ORDER BY updated_at DESC'
    ).all(namespace)) as DbFcmDeviceRow[]
    return rows.map(toStoredFcmDevice)
}
