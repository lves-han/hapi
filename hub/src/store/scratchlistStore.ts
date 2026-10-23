import type { Database } from './database'

import type { StoredScratchlistEntry } from './types'
import {
    countScratchlistEntries,
    createScratchlistEntry,
    deleteScratchlistEntry,
    getScratchlistEntry,
    listScratchlistEntries,
    sumScratchlistAttachmentBytesForSession,
    transferScratchlistEntries,
    updateScratchlistEntry,
    type CreateScratchlistResult
} from './scratchlist'

export class ScratchlistStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    async list(sessionId: string): Promise<StoredScratchlistEntry[]> {
        return this.db.operation(() => listScratchlistEntries(this.db, sessionId), false)
    }

    async count(sessionId: string): Promise<number> {
        return this.db.operation(() => countScratchlistEntries(this.db, sessionId), false)
    }

    async get(sessionId: string, entryId: string): Promise<StoredScratchlistEntry | null> {
        return this.db.operation(() => getScratchlistEntry(this.db, sessionId, entryId), false)
    }

    async create(
        sessionId: string,
        text: string,
        options?: {
            entryId?: string
            createdAt?: number
            attachments?: import('@hapi/protocol').ScratchlistAttachmentMetadata[]
        }
    ): Promise<CreateScratchlistResult> {
        return this.db.operation(() => createScratchlistEntry(this.db, sessionId, text, options), true)
    }

    async update(
        sessionId: string,
        entryId: string,
        patch: {
            text?: string
            attachments?: import('@hapi/protocol').ScratchlistAttachmentMetadata[]
        }
    ): Promise<StoredScratchlistEntry | null> {
        return this.db.operation(() => updateScratchlistEntry(this.db, sessionId, entryId, patch), true)
    }

    async sumAttachmentBytes(sessionId: string): Promise<number> {
        return this.db.operation(() => sumScratchlistAttachmentBytesForSession(this.db, sessionId), true)
    }

    async delete(sessionId: string, entryId: string): Promise<boolean> {
        return this.db.operation(() => deleteScratchlistEntry(this.db, sessionId, entryId), true)
    }

    /**
     * Re-point rows during a session merge. See
     * `transferScratchlistEntries` for the contract; the wrapper just
     * forwards through. Must be called BEFORE `deleteSession` so
     * `ON DELETE CASCADE` on `session_scratchlist.session_id` doesn't
     * race the migration. Required by tiann/hapi#920.
     */
    async transfer(fromSessionId: string, toSessionId: string): Promise<{ moved: number; collided: number }> {
        return this.db.operation(() => transferScratchlistEntries(this.db, fromSessionId, toSessionId), true)
    }
}
