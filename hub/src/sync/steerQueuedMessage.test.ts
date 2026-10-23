import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

async function createEngine() {
    const store = new Store(':memory:')
    const io = {
        of: () => ({
            to: () => ({ emit: () => {} })
        })
    }
    const engine = await SyncEngine.create(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
    return { store, engine }
}

describe('SyncEngine.steerQueuedMessage', () => {
    it('rejects every scheduled row, mature ones included, without invoking the CLI', async () => {
        const { store, engine } = (await createEngine())
        try {
            const session = (await engine.getOrCreateSession(
                'steer-scheduled',
                { path: '/tmp/project', host: 'localhost', flavor: 'pi' },
                { requests: {}, completedRequests: {} },
                'default'
            ))
            // A mature scheduled row: the fire time already passed, but the row
            // is still uninvoked and waiting for the scheduled-FIFO release.
            const message = (await store.messages.addMessage(
                session.id,
                { text: 'mature scheduled' },
                'mature-local',
                Date.now() - 1_000
            ))

            const result = await engine.steerQueuedMessage(session.id, message.id)

            expect(result).toEqual({
                status: 'failed',
                error: 'Scheduled messages cannot be steered',
                localId: 'mature-local'
            })
            // The row must stay queued — untouched by the rejected steer.
            const lookup = (await store.messages.lookupQueuedMessage(session.id, message.id))
            expect(lookup.status).toBe('queued')
        } finally {
            await engine.stop()
        }
    })

    it('rejects unsupported flavors without invoking the CLI', async () => {
        const { store, engine } = (await createEngine())
        try {
            const session = (await engine.getOrCreateSession(
                'steer-claude',
                { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
                { requests: {}, completedRequests: {} },
                'default'
            ))
            const message = (await store.messages.addMessage(session.id, { text: 'hi' }, 'local-id'))

            const result = await engine.steerQueuedMessage(session.id, message.id)

            expect(result).toEqual({
                status: 'failed',
                error: 'Steering is only supported for Pi, Codex, and Cursor ACP sessions',
                localId: null
            })
        } finally {
            await engine.stop()
        }
    })
})
