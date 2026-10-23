import type { SyncEvent } from '@hapi/protocol/types'
import type { SSEManager } from '../sse/sseManager'

export type SyncEventListener = (event: SyncEvent) => unknown

export class EventPublisher {
    private readonly listeners: Set<SyncEventListener> = new Set()

    constructor(
        private readonly sseManager: SSEManager,
        private readonly resolveNamespace: (event: SyncEvent) => string | undefined | Promise<string | undefined>
    ) {
    }

    subscribe(listener: SyncEventListener): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    async emit(event: SyncEvent): Promise<void> {
        const namespace = (await this.resolveNamespace(event))
        const enrichedEvent = namespace ? { ...event, namespace } : event

        for (const listener of this.listeners) {
            try {
                await listener(enrichedEvent)
            } catch (error) {
                console.error('[SyncEngine] Listener error:', error)
            }
        }

        this.sseManager.broadcast(enrichedEvent)
    }
}
