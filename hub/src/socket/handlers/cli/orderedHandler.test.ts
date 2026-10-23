import { describe, expect, it, mock } from 'bun:test'
import { orderedHandler, drainCliHandlers } from './orderedHandler'
import type { CliSocketWithData } from '../../socketTypes'

describe('CLI packet ordering', () => {
    it('finishes an earlier asynchronous packet before processing the next', async () => {
        let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        const events: string[] = []
        const socket = { conn: { close: mock() } } as unknown as CliSocketWithData
        const handle = orderedHandler(socket, 'message', async payload => {
            if (payload.localId === 'first') await gate
            events.push(payload.localId!)
        })
        handle({ sid: 'session', message: {}, localId: 'first' })
        handle({ sid: 'session', message: {}, localId: 'second' })
        await Promise.resolve()
        expect(events).toEqual([])
        release()
        await drainCliHandlers()
        expect(events).toEqual(['first', 'second'])
    })

    it('disconnects after a persistence failure and leaves queued packets for client reconciliation', async () => {
        const close = mock()
        const socket = { conn: { close } } as unknown as CliSocketWithData
        const delivered: string[] = []
        const handle = orderedHandler(socket, 'message', async payload => {
            if (payload.localId === 'failed') throw new Error('database unavailable')
            delivered.push(payload.localId!)
        })
        handle({ sid: 'session', message: {}, localId: 'failed' })
        handle({ sid: 'session', message: {}, localId: 'queued' })
        await drainCliHandlers()
        expect(close).toHaveBeenCalledTimes(1)
        expect(delivered).toEqual([])
    })
})
