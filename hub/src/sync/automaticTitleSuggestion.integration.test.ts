import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { RpcRegistry } from '../socket/rpcRegistry'
import { Store } from '../store'
import { SyncEngine } from './syncEngine'

const originalFetch = globalThis.fetch
const titleProviderEnvironment = {
    HAPI_TITLE_PROVIDER_BASE_URL: 'https://provider.example/v1',
    HAPI_TITLE_PROVIDER_API_KEY: 'secret',
    HAPI_TITLE_PROVIDER_MODEL: 'small-model'
} as const

const titleProviderEnvironmentKeys = Object.keys(titleProviderEnvironment) as Array<keyof typeof titleProviderEnvironment>
let restoreTitleProviderEnvironment: (() => void) | undefined

beforeEach(() => {
    const previous = new Map<string, string | undefined>()
    for (const key of titleProviderEnvironmentKeys) {
        previous.set(key, process.env[key])
        process.env[key] = titleProviderEnvironment[key]
    }
    restoreTitleProviderEnvironment = () => {
        for (const key of titleProviderEnvironmentKeys) {
            const value = previous.get(key)
            if (value === undefined) {
                delete process.env[key]
            } else {
                process.env[key] = value
            }
        }
    }
})

afterEach(() => {
    globalThis.fetch = originalFetch
    restoreTitleProviderEnvironment?.()
    restoreTitleProviderEnvironment = undefined
})

describe('automatic first-turn title generation', () => {
    it.each([true, false])('retains a partially answered first turn across restart (thinking heartbeat: %s)', async (thinkingHeartbeat) => {
        let calls = 0
        globalThis.fetch = (async () => {
            calls++
            return Response.json({ choices: [{ message: { content: 'Restarted first turn' } }] })
        }) as unknown as typeof fetch
        const store = new Store(':memory:')
        const createEngine = () => SyncEngine.create(store,
            { of: () => ({ to: () => ({ emit() {} }) }) } as never,
            new RpcRegistry(), { broadcast() {} } as never)
        let engine = await createEngine()
        try {
            const session = (await engine.getOrCreateSession('partial-first-turn-restart',
                { path: '/project', host: 'test' }, null, 'tenant'))
            const now = Date.now()
            await store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'Explain deployment' } })
            await engine.handleSessionAlive({ sid: session.id, time: now, thinking: true })
            await store.messages.addMessage(session.id, { role: 'assistant', content: { type: 'text', text: 'Checking deployment' } })
            await engine.stop()
            engine = await createEngine()
            if (thinkingHeartbeat) await engine.handleSessionAlive({ sid: session.id, time: now + 1, thinking: true })
            await store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'Include rollback' } })
            await store.messages.addMessage(session.id, { role: 'assistant', content: { type: 'text', text: 'Deployment and rollback explained' } })
            if (thinkingHeartbeat) {
                await engine.handleSessionAlive({ sid: session.id, time: now + 2, thinking: false })
            } else {
                const ready = (await store.messages.addMessage(session.id,
                    { role: 'agent', content: { type: 'event', data: { type: 'ready' } } }))
                await engine.handleRealtimeEvent({ type: 'message-received', sessionId: session.id, message: ready })
            }
            for (let i = 0; i < 20 && !(await engine.getSession(session.id))?.metadata?.summary; i++) {
                await new Promise(resolve => setTimeout(resolve, 0))
            }
            expect(calls).toBe(1)
            expect((await engine.getSession(session.id))?.metadata?.summary?.text).toBe('Restarted first turn')
        } finally {
            await engine.stop()
            await store.close()
        }
    })

    it.each(['batch', 'steer', 'heartbeat-steer'])('generates once for multiple prompts in the first %s turn', async (kind) => {
        let calls = 0
        globalThis.fetch = (async () => {
            calls++
            return Response.json({ choices: [{ message: { content: 'Deployment and rollback' } }] })
        }) as unknown as typeof fetch
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, { of: () => ({ to: () => ({ emit() {} }) }) } as never,
            new RpcRegistry(), { broadcast() {} } as never)
        try {
            const session = (await engine.getOrCreateSession(`first-turn-${kind}`,
                { path: '/project', host: 'test' }, null, 'tenant'))
            const now = Date.now()
            await store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'Explain deployment' } }, 'initial')
            await engine.handleSessionAlive({ sid: session.id, time: now, thinking: true })
            await store.messages.markMessagesInvoked(session.id, ['initial'], now)
            if (kind !== 'batch') {
                await store.messages.addMessage(session.id, { role: 'assistant', content: { type: 'text', text: 'Checking deployment' } })
            }
            await store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'Include rollback' } }, 'additional')
            await store.messages.markMessagesInvoked(session.id, ['additional'], now)
            await store.messages.addMessage(session.id, { role: 'assistant', content: { type: 'text', text: 'Deployment and rollback explained' } })
            if (kind === 'steer') {
                const ready = (await store.messages.addMessage(session.id,
                    { role: 'agent', content: { type: 'event', data: { type: 'ready' } } }))
                await engine.handleRealtimeEvent({ type: 'message-received', sessionId: session.id, message: ready })
            }
            await engine.handleSessionAlive({ sid: session.id, time: now + 1, thinking: false })
            for (let i = 0; i < 20 && !(await engine.getSession(session.id))?.metadata?.summary; i++) {
                await new Promise(resolve => setTimeout(resolve, 0))
            }
            expect(calls).toBe(1)
            expect((await engine.getSession(session.id))?.metadata?.summary?.text).toBe('Deployment and rollback')
        } finally {
            await engine.stop()
            await store.close()
        }
    })

    it.each(['ready', 'idle-without-completion', 'thinking'])('handles the %s completion boundary', async (boundary) => {
        let calls = 0
        globalThis.fetch = (async () => {
            calls++
            return Response.json({ choices: [{ message: { content: 'Ready boundary title' } }] })
        }) as unknown as typeof fetch
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, { of: () => ({ to: () => ({ emit() {} }) }) } as never,
            new RpcRegistry(), { broadcast() {} } as never)
        try {
            const session = (await engine.getOrCreateSession(`boundary-${boundary}`,
                { path: '/project', host: 'test' }, null, 'tenant'))
            await engine.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: boundary === 'thinking' })
            await store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'Explain deployment' } })
            const assistant = (await store.messages.addMessage(session.id,
                { role: 'assistant', content: { type: 'text', text: 'Here is the deployment process' } }))
            await engine.handleRealtimeEvent({ type: 'message-received', sessionId: session.id, message: assistant })
            await new Promise(resolve => setTimeout(resolve, 0))
            expect(calls).toBe(0)
            if (boundary === 'ready') {
                const ready = (await store.messages.addMessage(session.id,
                    { role: 'agent', content: { type: 'event', data: { type: 'ready' } } }))
                await engine.handleRealtimeEvent({ type: 'message-received', sessionId: session.id, message: ready })
                for (let i = 0; i < 20 && !(await engine.getSession(session.id))?.metadata?.summary; i++) {
                    await new Promise(resolve => setTimeout(resolve, 0))
                }
                expect(calls).toBe(1)
                expect((await engine.getSession(session.id))?.metadata?.summary?.text).toBe('Ready boundary title')
                expect((await engine.getSession(session.id))?.namespace).toBe('tenant')
            }
        } finally {
            await engine.stop()
            await store.close()
        }
    })

    it('runs after the thinking transition and persists the generated summary', async () => {
        const requests: Request[] = []
        globalThis.fetch = (async (input, init) => {
            requests.push(new Request(String(input), init))
            return new Response(JSON.stringify({
                choices: [{ message: { content: 'Deployment workflow' } }]
            }), { status: 200 })
        }) as typeof fetch

        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            { of: () => ({ to: () => ({ emit: () => {} }) }) } as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = (await engine.getOrCreateSession(
                'automatic-first-turn',
                { path: '/workspace/project', host: 'localhost' },
                null,
                'default'
            ))

            const now = Date.now()
            await engine.handleSessionAlive({ sid: session.id, time: now, thinking: false })
            await store.messages.addMessage(session.id, {
                role: 'user',
                content: { type: 'text', text: 'Explain the deployment workflow' }
            })
            await engine.handleSessionAlive({ sid: session.id, time: now + 1, thinking: true })
            await store.messages.addMessage(session.id, {
                role: 'assistant',
                content: { type: 'text', text: 'The workflow has three steps.' }
            })
            await engine.handleSessionAlive({ sid: session.id, time: now + 2, thinking: false })

            for (let attempt = 0; attempt < 20; attempt += 1) {
                if ((await engine.getSession(session.id))?.metadata?.summary?.text) break
                await new Promise((resolve) => setTimeout(resolve, 0))
            }

            expect(requests).toHaveLength(1)
            expect(requests[0]?.url).toBe('https://provider.example/v1/chat/completions')
            expect((await engine.getSession(session.id))?.metadata).toMatchObject({
                summary: { text: 'Deployment workflow' },
                titleSuggestionAutoAttemptedAt: expect.any(Number)
            })
        } finally {
            await engine.stop()
            await store.close()
        }
    })

    it('runs on a completed session end when no false heartbeat was observed', async () => {
        const requests: Request[] = []
        globalThis.fetch = (async (input, init) => {
            requests.push(new Request(String(input), init))
            return new Response(JSON.stringify({
                choices: [{ message: { content: 'Completed workflow' } }]
            }), { status: 200 })
        }) as typeof fetch

        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            { of: () => ({ to: () => ({ emit: () => {} }) }) } as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = (await engine.getOrCreateSession(
                'automatic-session-end',
                { path: '/workspace/project', host: 'localhost' },
                null,
                'default'
            ))
            const now = Date.now()
            await engine.handleSessionAlive({ sid: session.id, time: now, thinking: true })
            await store.messages.addMessage(session.id, {
                role: 'user',
                content: { type: 'text', text: 'Summarize the completed workflow' }
            })
            await store.messages.addMessage(session.id, {
                role: 'assistant',
                content: { type: 'text', text: 'The workflow completed successfully.' }
            })
            await engine.handleSessionEnd({ sid: session.id, time: now + 1, reason: 'completed' })

            for (let attempt = 0; attempt < 20; attempt += 1) {
                if ((await engine.getSession(session.id))?.metadata?.summary?.text) break
                await new Promise((resolve) => setTimeout(resolve, 0))
            }

            expect(requests).toHaveLength(1)
            expect((await engine.getSession(session.id))?.metadata?.summary?.text).toBe('Completed workflow')
        } finally {
            await engine.stop()
            await store.close()
        }
    })

    it('runs when the first assistant message arrives after the session is already idle', async () => {
        const requests: Request[] = []
        globalThis.fetch = (async (input, init) => {
            requests.push(new Request(String(input), init))
            return new Response(JSON.stringify({
                choices: [{ message: { content: 'Idle session workflow' } }]
            }), { status: 200 })
        }) as typeof fetch

        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            { of: () => ({ to: () => ({ emit: () => {} }) }) } as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = (await engine.getOrCreateSession(
                'automatic-message-arrival',
                { path: '/workspace/project', host: 'localhost' },
                null,
                'default'
            ))
            const now = Date.now()
            await engine.handleSessionAlive({ sid: session.id, time: now, thinking: false })
            await store.messages.addMessage(session.id, {
                role: 'user',
                content: { type: 'text', text: 'Summarize the idle workflow' }
            })
            await engine.handleSessionAlive({ sid: session.id, time: now + 1, thinking: true })
            await engine.handleSessionAlive({ sid: session.id, time: now + 2, thinking: false })
            const assistant = (await store.messages.addMessage(session.id, {
                role: 'assistant',
                content: { type: 'text', text: 'The workflow is complete.' }
            }))
            await engine.handleRealtimeEvent({
                type: 'message-received',
                sessionId: session.id,
                message: {
                    id: assistant.id,
                    seq: assistant.seq,
                    localId: assistant.localId,
                    content: assistant.content,
                    createdAt: assistant.createdAt,
                    invokedAt: assistant.invokedAt
                }
            } as never)

            for (let attempt = 0; attempt < 20; attempt += 1) {
                if ((await engine.getSession(session.id))?.metadata?.summary?.text) break
                await new Promise((resolve) => setTimeout(resolve, 0))
            }

            expect(requests).toHaveLength(1)
            expect((await engine.getSession(session.id))?.metadata?.summary?.text).toBe('Idle session workflow')
        } finally {
            await engine.stop()
            await store.close()
        }
    })
})
