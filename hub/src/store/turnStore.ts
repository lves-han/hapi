import type { Database } from './database'

import {
    abandonSessionTurnRecovery,
    closeDanglingSessionTurns,
    closeSessionTurn,
    listSessionTurns,
    openSessionTurn,
    resumeInterruptedSessionTurn,
    transferSessionTurns,
    type SessionTurn,
    type SessionTurnEndReason,
    type SessionTurnTrigger
} from './turns'

/** When agents were working: one row per stretch a session was thinking. */
export class TurnStore {
    constructor(private readonly db: Database) {}

    open(sessionId: string, namespace: string, startedAt: number, trigger: SessionTurnTrigger): Promise<boolean> {
        return this.db.operation(() => openSessionTurn(this.db, sessionId, namespace, startedAt, trigger), true)
    }

    close(sessionId: string, endedAt: number, reason: SessionTurnEndReason): Promise<boolean> {
        return this.db.operation(() => closeSessionTurn(this.db, sessionId, endedAt, reason), true)
    }

    closeDangling(now: number, recoveryWindowMs: number): Promise<string[]> {
        return this.db.operation(() => closeDanglingSessionTurns(this.db, now, recoveryWindowMs), true)
    }

    resumeInterrupted(sessionId: string, now: number): Promise<boolean> {
        return this.db.operation(() => resumeInterruptedSessionTurn(this.db, sessionId, now), true)
    }

    abandonRecovery(sessionId: string): Promise<void> {
        return this.db.operation(() => abandonSessionTurnRecovery(this.db, sessionId), true)
    }

    list(namespace: string, since: number, until: number): Promise<SessionTurn[]> {
        return this.db.operation(() => listSessionTurns(this.db, namespace, since, until), false)
    }

    transferSession(fromSessionId: string, toSessionId: string, now: number = Date.now()): Promise<void> {
        return this.db.operation(() => transferSessionTurns(this.db, fromSessionId, toSessionId, now), true)
    }
}
