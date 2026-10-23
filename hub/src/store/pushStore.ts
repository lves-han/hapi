import type { Database } from './database'

import type { StoredPushSubscription } from './types'
import { addPushSubscription, getPushSubscriptionsByNamespace, removePushSubscription } from './pushSubscriptions'

export class PushStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    async addPushSubscription(namespace: string, subscription: { endpoint: string; p256dh: string; auth: string }): Promise<void> {
        return this.db.operation(async () => {
            await addPushSubscription(this.db, namespace, subscription)

}, true)
    }

    async removePushSubscription(namespace: string, endpoint: string): Promise<void> {
        return this.db.operation(async () => {
            await removePushSubscription(this.db, namespace, endpoint)

}, true)
    }

    async getPushSubscriptionsByNamespace(namespace: string): Promise<StoredPushSubscription[]> {
        return this.db.operation(() => getPushSubscriptionsByNamespace(this.db, namespace), false)
    }
}
