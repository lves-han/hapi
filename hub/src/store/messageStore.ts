import type { Database } from './database'

import { hasConversationMessageContent } from '@hapi/protocol/messages'
import { decodeMessageContent } from './contentCodec'

import type { StoredMessage } from './types'
import {
    addMessage,
    syncNativeQueuedMessage,
    addImportedMessage,
    cancelQueuedMessage,
    deleteLiveReasoningSnapshots,
    deleteQueuedMessageById,
    claimIndeterminateMessage,
    lookupQueuedMessage,
    getMessages,
    getFirstMessages,
    getDeliverableMessagesAfter,
    getMessagesByPosition,
    getMessagesAfterPosition,
    getNewestMessagePosition,
    getMessageEpoch,
    bumpMessageEpoch,
    getLocalMessageStates,
    getUninvokedLocalMessages,
    getMatureScheduledMessages,
    getImmediateQueuedLocalMessages,
    countFutureScheduledBySessionIds,
    countFutureScheduledLocalMessages,
    minFutureScheduledAtBySessionIds,
    countMessages,
    markMessagesInvoked,
    markMessagesIndeterminate,
    setMessagesDeliveryState,
    markUninvokedImmediateMessages,
    mergeSessionMessages,
    moveUninvokedScheduledMessages,
    moveUninvokedMessages,
    copyMessageToSession as copyStoredMessageToSession,
    copyMessagesToSession as copyStoredMessagesToSession,
    getAllMessages,
    getMessagesAfterSeq,
    getMessageSeqById,
    truncateMessagesFromLocalId,
    type CancelQueuedMessageResult,
    type LookupQueuedMessageResult,
    type LocalMessageState,
    type MessagePosition,
} from './messages'

export class MessageStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    async addMessage(sessionId: string, content: unknown, localId?: string, scheduledAt?: number | null, createdAt?: number): Promise<StoredMessage> {
        return this.db.operation(() => addMessage(this.db, sessionId, content, localId, scheduledAt, createdAt), true)
    }

    async syncNativeQueuedMessage(sessionId: string, localId: string, text: string): Promise<StoredMessage> {
        return this.db.operation(() => syncNativeQueuedMessage(this.db, sessionId, localId, text), true)
    }

    async deleteLiveReasoningSnapshots(sessionId: string, streamId: string, keepMessageId?: string): Promise<number> {
        return this.db.operation(() => deleteLiveReasoningSnapshots(this.db, sessionId, streamId, keepMessageId), true)
    }

    async addImportedMessage(sessionId: string, content: unknown, localId: string, createdAt: number): Promise<{ message: StoredMessage; inserted: boolean }> {
        return this.db.operation(() => addImportedMessage(this.db, sessionId, content, localId, createdAt), true)
    }

    async copyMessageToSession(
        sessionId: string,
        message: Pick<StoredMessage, 'content' | 'createdAt' | 'localId' | 'invokedAt' | 'scheduledAt' | 'deliveryState'>
    ): Promise<StoredMessage> {
        return this.db.operation(() => copyStoredMessageToSession(this.db, sessionId, message), true)
    }

    async copyMessagesToSession(
        sessionId: string,
        messages: Array<Pick<StoredMessage, 'content' | 'createdAt' | 'localId' | 'invokedAt' | 'scheduledAt' | 'deliveryState'>>
    ): Promise<number> {
        return this.db.operation(() => copyStoredMessagesToSession(this.db, sessionId, messages), true)
    }

    async getAllMessages(sessionId: string): Promise<StoredMessage[]> {
        return this.db.operation(() => getAllMessages(this.db, sessionId), false)
    }

    async getMessagesAfterSeq(sessionId: string, afterSeq: number): Promise<StoredMessage[]> {
        return this.db.operation(() => getMessagesAfterSeq(this.db, sessionId, afterSeq), false)
    }

    async getSeqById(sessionId: string, messageId: string): Promise<number | null> {
        return this.db.operation(() => getMessageSeqById(this.db, sessionId, messageId), false)
    }

    async getMessages(sessionId: string, limit: number = 200): Promise<StoredMessage[]> {
        return this.db.operation(() => getMessages(this.db, sessionId, limit), false)
    }

    async getFirstMessages(sessionId: string, limit: number = 50): Promise<StoredMessage[]> {
        return this.db.operation(() => getFirstMessages(this.db, sessionId, limit), false)
    }

    async getDeliverableMessagesAfter(sessionId: string, afterSeq: number, now: number, limit: number = 200): Promise<StoredMessage[]> {
        return this.db.operation(() => getDeliverableMessagesAfter(this.db, sessionId, afterSeq, now, limit), false)
    }

    async getMessagesByPosition(sessionId: string, limit: number, before?: { at: number; seq: number }): Promise<StoredMessage[]> {
        return this.db.operation(() => getMessagesByPosition(this.db, sessionId, limit, before), false)
    }

    async getMessagesAfterPosition(
        sessionId: string,
        limit: number,
        after: MessagePosition,
        until?: MessagePosition
    ): Promise<StoredMessage[]> {
        return this.db.operation(() => getMessagesAfterPosition(this.db, sessionId, limit, after, until), false)
    }

    async getNewestMessagePosition(sessionId: string): Promise<MessagePosition | null> {
        return this.db.operation(() => getNewestMessagePosition(this.db, sessionId), false)
    }

    async getMessageEpoch(sessionId: string): Promise<number> {
        return this.db.operation(() => getMessageEpoch(this.db, sessionId), false)
    }

    async bumpMessageEpoch(sessionId: string): Promise<number> {
        return this.db.operation(() => bumpMessageEpoch(this.db, sessionId), true)
    }

    async getLocalMessageStates(sessionId: string, localIds: string[]): Promise<LocalMessageState[]> {
        return this.db.operation(() => getLocalMessageStates(this.db, sessionId, localIds), false)
    }

    async getUninvokedLocalMessages(sessionId: string, options?: { deliverableOnly?: boolean }): Promise<StoredMessage[]> {
        return this.db.operation(() => getUninvokedLocalMessages(this.db, sessionId, options), false)
    }

    async getMatureScheduledMessages(beforeTime: number): Promise<StoredMessage[]> {
        return this.db.operation(() => getMatureScheduledMessages(this.db, beforeTime), false)
    }

    async getImmediateQueuedLocalMessages(sessionId: string): Promise<StoredMessage[]> {
        return this.db.operation(() => getImmediateQueuedLocalMessages(this.db, sessionId), false)
    }

    async countFutureScheduledLocalMessages(sessionId: string, now: number = Date.now()): Promise<number> {
        return this.db.operation(() => countFutureScheduledLocalMessages(this.db, sessionId, now), false)
    }

    async countFutureScheduledBySessionIds(sessionIds: string[], now: number = Date.now()): Promise<Map<string, number>> {
        return this.db.operation(() => countFutureScheduledBySessionIds(this.db, sessionIds, now), false)
    }

    async minFutureScheduledAtBySessionIds(sessionIds: string[], now: number = Date.now()): Promise<Map<string, number>> {
        return this.db.operation(() => minFutureScheduledAtBySessionIds(this.db, sessionIds, now), false)
    }

    // ponytail: scans through leading bookkeeping; index content if that prefix becomes costly.
    async hasConversationContent(sessionId: string): Promise<boolean> {
        return this.db.operation(async () => {
            const query = this.db.prepare<{ content: string | Uint8Array }, [string]>(
                'SELECT content FROM messages WHERE session_id = ? ORDER BY seq ASC'
            )
            try {
                for await (const row of query.iterate(sessionId)) {
                    if (hasConversationMessageContent(decodeMessageContent(row.content))) return true
                }
                return false
            } finally {
                query.finalize()
            }

}, false)
    }

    async countMessages(sessionId: string): Promise<number> {
        return this.db.operation(() => countMessages(this.db, sessionId), false)
    }

    async cancelQueuedMessage(sessionId: string, messageId: string): Promise<CancelQueuedMessageResult> {
        return this.db.operation(() => cancelQueuedMessage(this.db, sessionId, messageId), true)
    }

    async lookupQueuedMessage(sessionId: string, messageId: string): Promise<LookupQueuedMessageResult> {
        return this.db.operation(() => lookupQueuedMessage(this.db, sessionId, messageId), true)
    }

    async deleteQueuedMessageById(sessionId: string, messageId: string): Promise<boolean> {
        return this.db.operation(() => deleteQueuedMessageById(this.db, sessionId, messageId), true)
    }

    async claimIndeterminateMessage(sessionId: string, messageId: string): Promise<StoredMessage | null> {
        return this.db.operation(() => claimIndeterminateMessage(this.db, sessionId, messageId), true)
    }

    async markMessagesInvoked(sessionId: string, localIds: string[], invokedAt: number): Promise<number> {
        return this.db.operation(() => markMessagesInvoked(this.db, sessionId, localIds, invokedAt), true)
    }

    async markMessagesIndeterminate(sessionId: string, localIds: string[]): Promise<number> {
        return this.db.operation(() => markMessagesIndeterminate(this.db, sessionId, localIds), true)
    }

    async setMessagesDeliveryState(sessionId: string, localIds: string[], state: 'queued' | 'dispatching' | 'indeterminate'): Promise<number> {
        return this.db.operation(() => setMessagesDeliveryState(this.db, sessionId, localIds, state), true)
    }

    async markUninvokedImmediateMessages(sessionId: string, invokedAt: number): Promise<string[]> {
        return this.db.operation(() => markUninvokedImmediateMessages(this.db, sessionId, invokedAt), true)
    }

    async moveUninvokedScheduledMessages(fromSessionId: string, toSessionId: string): Promise<number> {
        return this.db.operation(() => moveUninvokedScheduledMessages(this.db, fromSessionId, toSessionId), true)
    }

    async moveUninvokedMessages(fromSessionId: string, toSessionId: string): Promise<number> {
        return this.db.operation(() => moveUninvokedMessages(this.db, fromSessionId, toSessionId), true)
    }

    async mergeSessionMessages(fromSessionId: string, toSessionId: string): Promise<{ moved: number; oldMaxSeq: number; newMaxSeq: number }> {
        return this.db.operation(() => mergeSessionMessages(this.db, fromSessionId, toSessionId), true)
    }

    async truncateMessagesFromLocalId(
        sessionId: string,
        localId: string,
        replacement: Array<{
            content: unknown
            localId?: string | null
            createdAt?: number
            invokedAt?: number | null
        }> = []
    ): Promise<{ deleted: number; inserted: number; epoch: number }> {
        return this.db.operation(() => truncateMessagesFromLocalId(this.db, sessionId, localId, replacement), true)
    }
}
