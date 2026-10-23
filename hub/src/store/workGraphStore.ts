import type { Database } from './database'
import type {
    WorkGraphEvent,
    WorkGraphEventCreate,
    WorkGraphEventLink,
    WorkGraphEventLinkCreate
} from '@hapi/protocol'
import {
    getWorkGraphEventByNamespace,
    insertWorkGraphEvent,
    insertWorkGraphEventLink,
    listWorkGraphEventLinksForEvent,
    listWorkGraphEventsByRelatedSession,
    listWorkGraphWorkAdsByRelatedSession,
    reassignWorkGraphNotifySession,
    type InsertWorkGraphEventResult
} from './workGraph'

export class WorkGraphStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    async insertEvent(
        namespace: string,
        input: WorkGraphEventCreate,
        options?: { id?: string; ts?: number }
    ): Promise<InsertWorkGraphEventResult> {
        return this.db.operation(() => insertWorkGraphEvent(this.db, namespace, input, options), true)
    }

    async getEvent(eventId: string, namespace: string): Promise<WorkGraphEvent | null> {
        return this.db.operation(() => getWorkGraphEventByNamespace(this.db, eventId, namespace), false)
    }

    async listByRelatedSession(
        namespace: string,
        relatedSessionId: string,
        options?: { limit?: number }
    ): Promise<WorkGraphEvent[]> {
        return this.db.operation(() => listWorkGraphEventsByRelatedSession(this.db, namespace, relatedSessionId, options), false)
    }

    async listWorkAdsByRelatedSession(namespace: string, relatedSessionId: string): Promise<WorkGraphEvent[]> {
        return this.db.operation(() => listWorkGraphWorkAdsByRelatedSession(this.db, namespace, relatedSessionId), false)
    }

    async reassignNotifySession(namespace: string, oldSessionId: string, newSessionId: string): Promise<number> {
        return this.db.operation(() => reassignWorkGraphNotifySession(this.db, namespace, oldSessionId, newSessionId), true)
    }

    async insertLink(namespace: string, input: WorkGraphEventLinkCreate): Promise<WorkGraphEventLink> {
        return this.db.operation(() => insertWorkGraphEventLink(this.db, namespace, input), true)
    }

    async listLinksForEvent(namespace: string, eventId: string): Promise<WorkGraphEventLink[]> {
        return this.db.operation(() => listWorkGraphEventLinksForEvent(this.db, namespace, eventId), false)
    }
}
