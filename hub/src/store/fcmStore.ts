import type { Database } from './database'

import type { NativeDevicePlatform, StoredFcmDevice } from './types'
import { getFcmDevicesByNamespace, removeFcmDeviceByToken, upsertFcmDevice } from './fcmDevices'

/**
 * Native-device registry. Despite the historical `fcm_` naming, the table
 * holds every native push registration: Android phone/wear rows (FCM
 * tokens, optional phone `pushKey`) and iOS rows (hex APNs token + `pushKey`). Callers that send
 * through a specific pipeline must pass a platform filter so FCM never sees
 * APNs tokens and vice versa.
 */
export class FcmStore {
    constructor(private readonly db: Database) {}

    async upsertDevice(
        namespace: string,
        device: { token: string; platform: NativeDevicePlatform; deviceId: string; pushKey?: string }
    ): Promise<void> {
        return this.db.operation(async () => {
            await upsertFcmDevice(this.db, namespace, device)

}, true)
    }

    async removeDeviceByToken(namespace: string, token: string): Promise<void> {
        return this.db.operation(async () => {
            await removeFcmDeviceByToken(this.db, namespace, token)

}, true)
    }

    getDevicesByNamespace(namespace: string): Promise<StoredFcmDevice[]>
    getDevicesByNamespace<P extends NativeDevicePlatform>(
        namespace: string,
        platforms: readonly P[]
    ): Promise<Array<StoredFcmDevice & { platform: P }>>
    async getDevicesByNamespace(
        namespace: string,
        platforms?: readonly NativeDevicePlatform[]
    ): Promise<StoredFcmDevice[]> {
        return this.db.operation(() => getFcmDevicesByNamespace(this.db, namespace, platforms), false)
    }
}
