import type { Database } from './database'
import type { AttachedJob, AttachedJobPatch, AttachedJobUpsert } from '@hapi/protocol'

import type { StoredSessionJob } from './types'
import {
    deleteSessionJob,
    getPrimaryRunningJob,
    getPrimaryRunningJobsBySessionIds,
    getSessionJob,
    listSessionJobs,
    patchSessionJob,
    claimSessionJobTerminalWake,
    releaseSessionJobTerminalWake,
    markSessionJobTerminalWakeDelivered,
    clearAbandonedProvisionalWakeClaims,
    listPendingTerminalWakes,
    toAttachedJob,
    transferSessionJobs,
    upsertSessionJob,
    allocateRemappedJobKey,
    type DeleteSessionJobResult,
    type PatchSessionJobResult,
    type TransferSessionJobsResult,
    type UpsertSessionJobResult
} from './sessionJobs'

export class SessionJobsStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    list(sessionId: string): Promise<StoredSessionJob[]> {
        return this.db.operation(() => listSessionJobs(this.db, sessionId), false)
    }

    get(sessionId: string, jobKey: string): Promise<StoredSessionJob | null> {
        return this.db.operation(() => getSessionJob(this.db, sessionId, jobKey), false)
    }

    async getPrimaryRunning(sessionId: string): Promise<AttachedJob | null> {
        const job = await this.db.operation(() => getPrimaryRunningJob(this.db, sessionId), false)
        return job ? toAttachedJob(job) : null
    }

    getPrimaryRunningBySessionIds(sessionIds: string[]): Promise<Map<string, AttachedJob>> {
        return this.db.operation(() => getPrimaryRunningJobsBySessionIds(this.db, sessionIds), false)
    }

    upsert(
        sessionId: string,
        jobKey: string,
        body: AttachedJobUpsert,
        now?: number
    ): Promise<UpsertSessionJobResult> {
        return this.db.operation(() => upsertSessionJob(this.db, sessionId, jobKey, body, now), true)
    }

    patch(
        sessionId: string,
        jobKey: string,
        patch: AttachedJobPatch,
        now?: number
    ): Promise<PatchSessionJobResult> {
        return this.db.operation(() => patchSessionJob(this.db, sessionId, jobKey, patch, now), true)
    }

    /** One-shot provisional claim for #1489 terminal wake. */
    claimTerminalWake(sessionId: string, jobKey: string): Promise<StoredSessionJob | null> {
        return this.db.operation(() => claimSessionJobTerminalWake(this.db, sessionId, jobKey), true)
    }

    /** Release a provisional wake claim after a recoverable delivery failure. */
    releaseTerminalWake(sessionId: string, jobKey: string, expectedClaimId: string): Promise<boolean> {
        return this.db.operation(() => releaseSessionJobTerminalWake(this.db, sessionId, jobKey, expectedClaimId), true)
    }

    /** Persist durable wake delivery after the prompt is stored. */
    markTerminalWakeDelivered(sessionId: string, jobKey: string, claimId: string): Promise<boolean> {
        return this.db.operation(() => markSessionJobTerminalWakeDelivered(this.db, sessionId, jobKey, claimId), true)
    }

    /** Clear abandoned `pending:*` markers after hub restart. */
    clearAbandonedProvisionalWakeClaims(): Promise<number> {
        return this.db.operation(() => clearAbandonedProvisionalWakeClaims(this.db), true)
    }

    /** Terminal + opt-in jobs still awaiting wake delivery for their current run. */
    listPendingTerminalWakes(): Promise<StoredSessionJob[]> {
        return this.db.operation(() => listPendingTerminalWakes(this.db), false)
    }

    delete(
        sessionId: string,
        jobKey: string,
        expectedRunId?: string
    ): Promise<DeleteSessionJobResult> {
        return this.db.operation(() => deleteSessionJob(this.db, sessionId, jobKey, expectedRunId), true)
    }

    transfer(fromSessionId: string, toSessionId: string): Promise<TransferSessionJobsResult> {
        return this.db.operation(() => transferSessionJobs(this.db, fromSessionId, toSessionId), true)
    }

    allocateRemappedKey(
        toSessionId: string,
        fromSessionId: string,
        fromKey: string
    ): Promise<string> {
        return this.db.operation(() => allocateRemappedJobKey(this.db, toSessionId, fromSessionId, fromKey), false)
    }
}
