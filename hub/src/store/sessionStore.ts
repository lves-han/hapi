import type { Database } from './database'
import { bumpSessionDeletionEpoch } from './sessionInvalidation'

import type { StoredSession, VersionedUpdateResult } from './types'
import {
    deleteSession,
    getOrCreateSession,
    adoptPreallocatedSession,
    getSession,
    getSessionByNamespace,
    getSessions,
    getSessionsByNamespace,
    setSessionEffort,
    setSessionModel,
    setSessionModelReasoningEffort,
    setSessionServiceTier,
    setSessionActive,
    setSessionPinned,
    setSessionPinMode,
    type SessionPinMode,
    setSessionTeamState,
    setSessionTodos,
    replaceSessionTodos,
    touchSessionUpdatedAt,
    updateSessionAgentState,
    updateSessionMetadata
} from './sessions'

export class SessionStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    async getOrCreateSession(
        tag: string,
        metadata: unknown,
        agentState: unknown,
        namespace: string,
        model?: string,
        effort?: string,
        modelReasoningEffort?: string,
        requestedId?: string
    ): Promise<StoredSession> {
        return this.db.operation(() => getOrCreateSession(this.db, tag, metadata, agentState, namespace, model, effort, modelReasoningEffort, requestedId), true)
    }

    async adoptPreallocatedSession(
        id: string,
        tag: string,
        metadata: unknown,
        agentState: unknown,
        namespace: string,
        model?: string,
        effort?: string,
        modelReasoningEffort?: string
    ): Promise<StoredSession> {
        return this.db.operation(() => adoptPreallocatedSession(
            this.db, id, tag, metadata, agentState, namespace, model, effort, modelReasoningEffort
        ), true)
    }

    async updateSessionMetadata(
        id: string,
        metadata: unknown,
        expectedVersion: number,
        namespace: string,
        options?: { touchUpdatedAt?: boolean; allowUnarchive?: boolean }
    ): Promise<VersionedUpdateResult<unknown | null>> {
        return this.db.operation(() => updateSessionMetadata(this.db, id, metadata, expectedVersion, namespace, options), true)
    }

    async updateSessionAgentState(
        id: string,
        agentState: unknown,
        expectedVersion: number,
        namespace: string
    ): Promise<VersionedUpdateResult<unknown | null>> {
        return this.db.operation(() => updateSessionAgentState(this.db, id, agentState, expectedVersion, namespace), true)
    }

    async setSessionTodos(id: string, todos: unknown, todosUpdatedAt: number, namespace: string): Promise<boolean> {
        return this.db.operation(() => setSessionTodos(this.db, id, todos, todosUpdatedAt, namespace), true)
    }

    async replaceSessionTodos(
        id: string,
        todos: unknown,
        namespace: string
    ): Promise<boolean> {
        return this.db.operation(() => replaceSessionTodos(this.db, id, todos, namespace), true)
    }

    async setSessionTeamState(id: string, teamState: unknown, updatedAt: number, namespace: string): Promise<boolean> {
        return this.db.operation(() => setSessionTeamState(this.db, id, teamState, updatedAt, namespace), true)
    }

    async setSessionModel(id: string, model: string | null, namespace: string, options?: { touchUpdatedAt?: boolean }): Promise<boolean> {
        return this.db.operation(() => setSessionModel(this.db, id, model, namespace, options), true)
    }

    async setSessionModelReasoningEffort(
        id: string,
        modelReasoningEffort: string | null,
        namespace: string,
        options?: { touchUpdatedAt?: boolean }
    ): Promise<boolean> {
        return this.db.operation(() => setSessionModelReasoningEffort(this.db, id, modelReasoningEffort, namespace, options), true)
    }

    async setSessionEffort(id: string, effort: string | null, namespace: string, options?: { touchUpdatedAt?: boolean }): Promise<boolean> {
        return this.db.operation(() => setSessionEffort(this.db, id, effort, namespace, options), true)
    }

    async setSessionServiceTier(id: string, serviceTier: string | null, namespace: string, options?: { touchUpdatedAt?: boolean }): Promise<boolean> {
        return this.db.operation(() => setSessionServiceTier(this.db, id, serviceTier, namespace, options), true)
    }

    async setSessionActive(id: string, active: boolean, activeAt: number, namespace: string): Promise<boolean> {
        return this.db.operation(() => setSessionActive(this.db, id, active, activeAt, namespace), true)
    }

    async setSessionPinned(id: string, pinned: boolean, namespace: string): Promise<boolean> {
        return this.db.operation(() => setSessionPinned(this.db, id, pinned, namespace), true)
    }

    async setSessionPinMode(id: string, mode: SessionPinMode, namespace: string): Promise<boolean> {
        return this.db.operation(() => setSessionPinMode(this.db, id, mode, namespace), true)
    }

    async touchSessionUpdatedAt(id: string, updatedAt: number, namespace: string): Promise<boolean> {
        return this.db.operation(() => touchSessionUpdatedAt(this.db, id, updatedAt, namespace), true)
    }

    async getSession(id: string): Promise<StoredSession | null> {
        return this.db.operation(() => getSession(this.db, id), false)
    }

    async getSessionByNamespace(id: string, namespace: string): Promise<StoredSession | null> {
        return this.db.operation(() => getSessionByNamespace(this.db, id, namespace), false)
    }

    async getSessions(): Promise<StoredSession[]> {
        return this.db.operation(() => getSessions(this.db), false)
    }

    async getSessionsByNamespace(namespace: string): Promise<StoredSession[]> {
        return this.db.operation(() => getSessionsByNamespace(this.db, namespace), false)
    }

    async deleteSession(id: string, namespace: string): Promise<boolean> {
        const deleted = await this.db.operation(() => deleteSession(this.db, id, namespace), true)
        // Invalidate access memos and pending cache snapshots only after commit.
        if (deleted) bumpSessionDeletionEpoch()
        return deleted
    }
}
