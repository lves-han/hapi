import type { Database } from './database'

import type { StoredUser } from './types'
import { addUser, getUser, getUsersByPlatform, getUsersByPlatformAndNamespace, removeUser } from './users'

export class UserStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    async getUser(platform: string, platformUserId: string): Promise<StoredUser | null> {
        return this.db.operation(() => getUser(this.db, platform, platformUserId), false)
    }

    async getUsersByPlatform(platform: string): Promise<StoredUser[]> {
        return this.db.operation(() => getUsersByPlatform(this.db, platform), false)
    }

    async getUsersByPlatformAndNamespace(platform: string, namespace: string): Promise<StoredUser[]> {
        return this.db.operation(() => getUsersByPlatformAndNamespace(this.db, platform, namespace), false)
    }

    async addUser(platform: string, platformUserId: string, namespace: string): Promise<StoredUser> {
        return this.db.operation(() => addUser(this.db, platform, platformUserId, namespace), true)
    }

    async removeUser(platform: string, platformUserId: string): Promise<boolean> {
        return this.db.operation(() => removeUser(this.db, platform, platformUserId), true)
    }
}
