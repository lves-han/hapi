import { describe, expect, it } from 'bun:test'
import type { Metadata } from '@hapi/protocol/types'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'
import type { RpcGateway } from './rpcGateway'

async function fixture() {
    const store = new Store(':memory:')
    const engine = await SyncEngine.create(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    const metadata: Metadata = { path: '/tmp/work', host: 'test', machineId: 'machine', hostPid: 42, flavor: 'codex',
        capabilities: { concurrentClients: true, conversationHistory: { forkCurrent: true, forkAtMessage: true } } }
    const create = async (name: string, more: Partial<Metadata> = {}) => {
        const session = (await engine.getOrCreateSession(name, { ...metadata, codexSessionId: `native-${name}`, ...more }, { controlledByUser: false }, 'default'))
        await engine.handleSessionAlive({ sid: session.id, time: Date.now() })
        await engine.handleSessionReady({ sid: session.id, time: Date.now() })
        return session
    }
    return { store, engine, create, rpc: (engine as unknown as { rpcGateway: RpcGateway }).rpcGateway }
}

describe('shared Codex hub binding', () => {
    it('restores the generated fork summary after child startup replaces provisional metadata', async () => {
        const { store, engine, create, rpc } = (await fixture())
        try {
            const source = (await create('source', { name: 'Source title' }))
            rpc.forkConversation = async () => ({ nativeSessionId: 'native-child' })
            rpc.spawnSession = async (...args) => {
                const childId = args[12]!
                const child = (await store.sessions.getSession(childId))!
                await store.sessions.updateSessionMetadata(childId, {
                    path: '/tmp/work', host: 'test', machineId: 'machine', flavor: 'codex',
                    codexSessionId: 'native-child'
                }, child.metadataVersion, 'default')
                await (engine as unknown as { sessionCache: { refreshSession(id: string): Promise<unknown> } })
                    .sessionCache.refreshSession(childId)
                await engine.handleSessionAlive({ sid: childId, time: Date.now() })
                await engine.handleSessionReady({ sid: childId, time: Date.now() })
                return { type: 'success', sessionId: childId }
            }
            const result = await engine.forkConversation(source.id, 'default')
            expect(result.type).toBe('success')
            if (result.type !== 'success') throw new Error(result.message)
            expect((await engine.getSession(result.sessionId))?.metadata?.summary?.text).toBe('Fork: Source title')
        } finally { await engine.stop() }
    })

    it('allows Codex historical forks while thinking but retains other history guards', async () => {
        const { store, engine, create, rpc } = (await fixture())
        try {
            const source = (await create('source', { conversationHistoryPoints: { boundary: true } }))
            const child = (await create('child', { forkedFrom: source.id }))
            await store.messages.addMessage(source.id, { role: 'user', content: 'boundary' }, 'boundary')
            await store.messages.markMessagesInvoked(source.id, ['boundary'], Date.now())
            await engine.handleSessionAlive({ sid: source.id, time: Date.now(), thinking: true })
            let calls = 0
            rpc.forkConversation = async () => { calls++; return { nativeSessionId: 'native-child', sessionId: child.id } }
            expect(await engine.forkConversation(source.id, 'default', 'boundary')).toEqual({ type: 'success', sessionId: child.id })
            expect((await engine.getSession(source.id))?.thinking).toBe(true)
            expect(await engine.forkConversation(source.id, 'default')).toMatchObject({ type: 'error', message: 'Session is busy' })
            expect(await engine.rewindConversation(source.id, 'default', 'boundary')).toMatchObject({ type: 'error', message: 'Session is busy' })
            await store.messages.addMessage(source.id, { role: 'user', content: 'queued' }, 'queued')
            expect(await engine.forkConversation(source.id, 'default', 'boundary')).toMatchObject({ type: 'error', message: 'Session has queued messages' })
            expect(calls).toBe(1)
        } finally { await engine.stop() }
    })
    it('guards plan actions by namespace and runtime, leaving stale-plan and retry validation to CLI', async () => {
        const { engine, create, rpc } = (await fixture())
        try {
            const source = (await create('source'))
            const unsupported = (await create('other', { flavor: 'claude' }))
            const calls: string[][] = []
            rpc.implementCodexPlan = async (...args) => { calls.push(args); return { ok: true } }
            expect(await engine.implementCodexPlan(source.id, 'other-namespace', 'plan')).toMatchObject({ ok: false })
            expect(await engine.implementCodexPlan(unsupported.id, 'default', 'plan')).toMatchObject({ ok: false })
            expect(calls).toHaveLength(0)
            // The hub can lag the native plan state, including after an accepted action's lost reply.
            expect(await engine.implementCodexPlan(source.id, 'default', 'plan')).toEqual({ ok: true })
            expect(calls).toEqual([[source.id, 'plan']])
        } finally { await engine.stop() }
    })

    it('uses the already-bound fork child without spawning a second engine', async () => {
        const { engine, create, rpc } = (await fixture())
        try {
            const source = (await create('source')); const child = (await create('child', { forkedFrom: source.id }))
            rpc.forkConversation = async () => ({ nativeSessionId: 'native-child', sessionId: child.id })
            expect(await engine.forkConversation(source.id, 'default')).toEqual({ type: 'success', sessionId: child.id })
            expect((await engine.getSession(source.id))?.metadata?.codexSessionId).toBe('native-source')
        } finally { await engine.stop() }
    })
    it('clear returns a new root without superseding other clients and mode switching is inapplicable', async () => {
        const { engine, create, rpc } = (await fixture())
        try {
            const source = (await create('source')); const child = (await create('child'))
            rpc.clearConversation = async () => ({ sessionId: child.id })
            expect(await engine.clearConversation(source.id, 'default')).toEqual({ sessionId: child.id })
            expect((await engine.getSession(source.id))?.metadata?.supersededBySessionId).toBeUndefined()
            await expect(engine.switchSession(source.id, 'remote')).rejects.toThrow('control_mode_not_applicable')
            await expect(engine.clearConversation(source.id, 'other-namespace')).rejects.toThrow()
        } finally { await engine.stop() }
    })
})
