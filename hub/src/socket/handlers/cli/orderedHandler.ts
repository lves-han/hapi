import type { ClientToServerEvents } from '@hapi/protocol'
import type { CliSocketWithData } from '../../socketTypes'

const tails = new WeakMap<object, Promise<void>>()
const active = new Set<Promise<void>>()
const failed = new WeakSet<object>()

export async function drainCliHandlers(): Promise<void> {
    await Promise.all([...active])
}

/** Preserve per-connection packet order while storage calls yield to PostgreSQL. */
export function orderedHandler<K extends keyof ClientToServerEvents>(
    socket: CliSocketWithData,
    event: K,
    handler: (...args: Parameters<ClientToServerEvents[K]>) => unknown
): ClientToServerEvents[K] {
    const wrapped = (...args: Parameters<ClientToServerEvents[K]>) => {
        const task = (tails.get(socket) ?? Promise.resolve()).then(async () => {
            if (!failed.has(socket)) await handler(...args)
        })
        const settled = task.catch(() => {
            failed.add(socket)
            console.error(`[CLI] ${event} failed; closing connection so the client can reconcile persisted state`)
            // A transport close lets existing clients reconnect automatically.
            socket.conn.close()
        })
        tails.set(socket, settled)
        active.add(settled)
        void settled.finally(() => active.delete(settled))
        return settled
    }
    return wrapped as unknown as ClientToServerEvents[K]
}
