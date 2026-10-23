import type { Database } from './database'

import {
    getUsageEvents,
    getUsageScanStates,
    recordUsageScan,
    transferUsageSession,
    type UsageEvent,
    type UsageScanState
} from './usage'

export class UsageStore {
    constructor(private readonly db: Database) {}

    async recordScan(
        sessionId: string,
        messageEpoch: number,
        lastSeq: number,
        events: UsageEvent[],
        replaceEvents: boolean
    ): Promise<void> {
        return this.db.operation(async () => {
            await recordUsageScan(this.db, sessionId, messageEpoch, lastSeq, events, replaceEvents)

}, true)
    }

    async getEvents(sessionIds: string[]): Promise<UsageEvent[]> {
        return this.db.operation(() => getUsageEvents(this.db, sessionIds), false)
    }

    async getScanStates(sessionIds: string[]): Promise<Map<string, UsageScanState>> {
        return this.db.operation(() => getUsageScanStates(this.db, sessionIds), false)
    }

    async transferSession(fromSessionId: string, toSessionId: string): Promise<void> {
        return this.db.operation(async () => {
            await transferUsageSession(this.db, fromSessionId, toSessionId)

}, true)
    }
}
