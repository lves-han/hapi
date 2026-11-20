import { describe, expect, it } from 'bun:test'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import { Store } from './index'

function makeStore(): Store {
    return new Store(':memory:')
}

function makeSession(store: Store, tag: string) {
    return store.sessions.getOrCreateSession(tag, { path: `/tmp/${tag}` }, null, 'default')
}

function makeToolCall(callId: string, status: string, input: Record<string, unknown> = { cmd: 'ls' }) {
    return {
        role: 'agent',
        content: {
            type: AGENT_MESSAGE_PAYLOAD_TYPE,
            data: { type: 'tool-call', callId, name: 'bash', input, status }
        }
    }
}

function makeToolResult(callId: string, output = 'ok') {
    return {
        role: 'agent',
        content: {
            type: AGENT_MESSAGE_PAYLOAD_TYPE,
            data: { type: 'tool-call-result', callId, output }
        }
    }
}

function makeReasoning(streamId: string, text: string, live: boolean) {
    return {
        role: 'agent',
        content: {
            type: AGENT_MESSAGE_PAYLOAD_TYPE,
            data: { type: 'reasoning', message: text, id: streamId, ...(live ? { live: true } : {}) }
        }
    }
}

describe('liveTailCache & cursor pagination', () => {
    it('keeps repeated tool-call upserts and reasoning replacements consistent on a 500-message session', async () => {
        const store = makeStore()
        const session = await makeSession(store, 'tail-large-session')

        for (let i = 0; i < 500; i += 1) {
            await store.messages.addMessage(session.id, {
                role: 'agent',
                content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: { type: 'message', message: `history-${i}` } }
            })
        }

        const firstTool = await store.messages.upsertToolCallMessage(session.id, makeToolCall('call-live', 'pending'), 'call-live')
        expect(firstTool.updated).toBe(false)

        for (let tick = 0; tick < 20; tick += 1) {
            const status = tick === 19 ? 'completed' : 'in_progress'
            const next = await store.messages.upsertToolCallMessage(
                session.id,
                makeToolCall('call-live', status, { cmd: 'ls', tick }),
                'call-live'
            )
            expect(next.updated).toBe(true)
            expect(next.message.id).toBe(firstTool.message.id)
        }

        let lastReasoningId = ''
        for (let chunk = 0; chunk < 20; chunk += 1) {
            const stored = await store.messages.addMessage(
                session.id,
                makeReasoning('stream-live', `thinking-${chunk}`, chunk < 19)
            )
            await store.messages.deleteLiveReasoningSnapshots(session.id, 'stream-live', stored.id)
            lastReasoningId = stored.id
        }

        const all = await store.messages.getAllMessages(session.id)
        // 500 history + 1 upserted tool call + 1 settled reasoning row
        expect(all).toHaveLength(502)
        expect(all.at(-1)?.id).toBe(lastReasoningId)
        await store.close()
    })

    it('handles deleteLiveReasoningSnapshots without keepMessageId cleanly when deleting head row', async () => {
        const store = makeStore()
        const session = await makeSession(store, 'tail-delete-head')

        const first = await store.messages.addMessage(session.id, makeReasoning('stream-a', 'chunk-1', true))
        const second = await store.messages.addMessage(session.id, makeReasoning('stream-a', 'chunk-2', true))
        expect(second.seq).toBeGreaterThan(first.seq)

        const removed = await store.messages.deleteLiveReasoningSnapshots(session.id, 'stream-a')
        expect(removed).toBe(2)

        const replacement = await store.messages.addMessage(session.id, makeReasoning('stream-a', 'settled', false))
        expect((await store.messages.getAllMessages(session.id)).map((m) => m.id)).toEqual([replacement.id])
        await store.close()
    })

    it('stops reusing a cached live tool call after tool-call-result or a user turn boundary', async () => {
        const store = makeStore()
        const session = await makeSession(store, 'tail-boundaries')

        const callA1 = await store.messages.upsertToolCallMessage(session.id, makeToolCall('call-A', 'in_progress'), 'call-A')
        await store.messages.addMessage(session.id, makeToolResult('call-A', 'done'))

        const callA2 = await store.messages.upsertToolCallMessage(session.id, makeToolCall('call-A', 'in_progress'), 'call-A')
        expect(callA2.updated).toBe(false)
        expect(callA2.message.id).not.toBe(callA1.message.id)

        const callB1 = await store.messages.upsertToolCallMessage(session.id, makeToolCall('call-B', 'in_progress'), 'call-B')
        await store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'next turn' } })

        const callB2 = await store.messages.upsertToolCallMessage(session.id, makeToolCall('call-B', 'in_progress'), 'call-B')
        expect(callB2.updated).toBe(false)
        expect(callB2.message.id).not.toBe(callB1.message.id)
        await store.close()
    })

    it('invalidates the live tail cache on rewind truncation', async () => {
        const store = makeStore()
        const session = await makeSession(store, 'tail-rewind')

        await store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'turn-1' } }, 'lid-1')
        await store.messages.upsertToolCallMessage(session.id, makeToolCall('call-rewind', 'in_progress'), 'call-rewind')
        await store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'turn-2' } }, 'lid-2')
        await store.messages.upsertToolCallMessage(session.id, makeToolCall('call-after', 'in_progress'), 'call-after')

        await store.messages.truncateMessagesFromLocalId(session.id, 'lid-2')

        // call-after was rewound; call-rewind survived and remains updatable.
        const freshAfter = await store.messages.upsertToolCallMessage(session.id, makeToolCall('call-after', 'in_progress'), 'call-after')
        expect(freshAfter.updated).toBe(false)

        await store.messages.truncateMessagesFromLocalId(session.id, 'lid-1')
        const restarted = await store.messages.upsertToolCallMessage(session.id, makeToolCall('call-rewind', 'in_progress'), 'call-rewind')
        expect(restarted.updated).toBe(false)
        await store.close()
    })

    it('scans across multiple cursor pages in hasConversationContent without skipping rows', async () => {
        const store = makeStore()
        const session = await makeSession(store, 'cursor-conv-check')

        for (let i = 0; i < 40; i += 1) {
            await store.messages.addMessage(session.id, {
                role: 'agent',
                content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: { type: 'event', payload: { idx: i } } }
            })
        }
        expect(await store.messages.hasConversationContent(session.id)).toBe(false)

        await store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'actual prompt' } })
        expect(await store.messages.hasConversationContent(session.id)).toBe(true)
        await store.close()
    })

    it('replenishes the 200-row tool-call lookback window after deleting reasoning snapshots', async () => {
        const store = makeStore()
        const session = await makeSession(store, 'tail-replenish-lookback')

        const boundaryCall = await store.messages.upsertToolCallMessage(
            session.id,
            makeToolCall('call-boundary', 'in_progress'),
            'call-boundary'
        )
        for (let i = 0; i < 198; i += 1) {
            await store.messages.addMessage(session.id, {
                role: 'agent',
                content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: { type: 'event', payload: { idx: i } } }
            })
        }
        // Row 200 is a live reasoning snapshot; cache currently holds 200 rows.
        await store.messages.addMessage(session.id, makeReasoning('stream-edge', 'partial', true))

        // Appending replacement shifts boundaryCall outside 200 rows until deletion restores it into range.
        const settled = await store.messages.addMessage(session.id, makeReasoning('stream-edge', 'final', false))
        expect(await store.messages.deleteLiveReasoningSnapshots(session.id, 'stream-edge', settled.id)).toBe(1)

        const completed = await store.messages.upsertToolCallMessage(
            session.id,
            makeToolCall('call-boundary', 'completed'),
            'call-boundary'
        )
        expect(completed.updated).toBe(true)
        expect(completed.message.id).toBe(boundaryCall.message.id)
        await store.close()
    })
})
