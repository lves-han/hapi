import { describe, expect, it } from 'bun:test'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import type { SyncEvent, SessionPatch } from '@hapi/protocol/types'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

function createEngine(store: Store): { engine: SyncEngine; events: SyncEvent[] } {
    const events: SyncEvent[] = []
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    engine.subscribe((event) => { events.push(event) })
    return { engine, events }
}

function acpToolCall(callId: string): unknown {
    return {
        role: 'agent',
        content: {
            type: AGENT_MESSAGE_PAYLOAD_TYPE,
            data: { type: 'tool-call', callId, name: 'Bash', input: {}, status: 'in_progress' }
        }
    }
}

function acpToolCallResult(callId: string): unknown {
    return {
        role: 'agent',
        content: {
            type: AGENT_MESSAGE_PAYLOAD_TYPE,
            data: { type: 'tool-call-result', callId, output: 'done' }
        }
    }
}

function derivedWorkPatches(events: SyncEvent[], sessionId: string): Array<boolean | undefined> {
    return events
        .filter((event): event is Extract<SyncEvent, { type: 'session-updated' }> =>
            event.type === 'session-updated' && event.sessionId === sessionId)
        .map((event) => (event.data as SessionPatch | undefined)?.derivedToolWork)
        .filter((value) => value !== undefined)
}

async function tick(engine: SyncEngine): Promise<void> {
    await (engine as unknown as { expireInactive(): Promise<void> }).expireInactive()
}

describe('sync engine derived tool work sweep', () => {
    it('derives open tool work for a connected non-thinking session and clears it when the call settles', async () => {
        const store = new Store(':memory:')
        const { engine, events } = createEngine(store)
        try {
            const session = await engine.getOrCreateSession(
                'engine-derived-sweep',
                { path: '/tmp/project', host: 'localhost', flavor: 'gemini' },
                null,
                'default'
            )
            await engine.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: false })

            // Autonomous round: the result already flipped thinking off, but a
            // tool call never settled.
            await store.messages.upsertToolCallMessage(session.id, acpToolCall('call-1'), 'call-1')
            await tick(engine)

            expect((await engine.getSession(session.id))?.derivedToolWork).toBe(true)
            expect(derivedWorkPatches(events, session.id)).toEqual([true])

            await store.messages.addMessage(session.id, acpToolCallResult('call-1'))
            await tick(engine)

            expect((await engine.getSession(session.id))?.derivedToolWork).toBe(false)
            expect(derivedWorkPatches(events, session.id)).toEqual([true, false])
        } finally {
            await engine.stop()
            await store.close()
        }
    })

    it('skips thinking sessions and clears a stale flag once the session turns ineligible', async () => {
        const store = new Store(':memory:')
        const { engine } = createEngine(store)
        try {
            const session = await engine.getOrCreateSession(
                'engine-derived-thinking',
                { path: '/tmp/project', host: 'localhost', flavor: 'gemini' },
                null,
                'default'
            )
            await engine.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: false })
            await store.messages.upsertToolCallMessage(session.id, acpToolCall('call-1'), 'call-1')
            await tick(engine)
            expect((await engine.getSession(session.id))?.derivedToolWork).toBe(true)

            // A foreground turn starts: thinking carries the spinner itself, so
            // the derived flag must not linger.
            await engine.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true })
            await tick(engine)
            expect((await engine.getSession(session.id))?.derivedToolWork ?? false).toBe(false)

            // And a thinking session with open work never derives the flag.
            await store.messages.upsertToolCallMessage(session.id, acpToolCall('call-2'), 'call-2')
            await tick(engine)
            expect((await engine.getSession(session.id))?.derivedToolWork ?? false).toBe(false)
        } finally {
            await engine.stop()
            await store.close()
        }
    })

    it('skips sessions that already render work: background tasks or a running attached job', async () => {
        const store = new Store(':memory:')
        const { engine } = createEngine(store)
        try {
            const withTasks = await engine.getOrCreateSession(
                'engine-derived-tasks',
                { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
                null,
                'default'
            )
            await engine.handleSessionAlive({ sid: withTasks.id, time: Date.now(), thinking: false })
            await store.messages.upsertToolCallMessage(withTasks.id, acpToolCall('call-t'), 'call-t')
            await (engine as unknown as {
                sessionCache: { setBackgroundTasks(id: string, tasks: unknown[]): Promise<void> }
            }).sessionCache.setBackgroundTasks(withTasks.id, [
                { id: 'b1', type: 'local_bash', description: 'long job' }
            ])

            const withJob = await engine.getOrCreateSession(
                'engine-derived-job',
                { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
                null,
                'default'
            )
            await engine.handleSessionAlive({ sid: withJob.id, time: Date.now(), thinking: false })
            await store.messages.upsertToolCallMessage(withJob.id, acpToolCall('call-j'), 'call-j')
            await engine.upsertSessionJob(withJob.id, 'import', { label: 'beets import', status: 'running' })

            await tick(engine)

            expect((await engine.getSession(withTasks.id))?.derivedToolWork ?? false).toBe(false)
            expect((await engine.getSession(withJob.id))?.derivedToolWork ?? false).toBe(false)
        } finally {
            await engine.stop()
            await store.close()
        }
    })
})
