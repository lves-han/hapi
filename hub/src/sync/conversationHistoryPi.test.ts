import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

async function createEngine() {
    const store = new Store(':memory:')
    const engine = await SyncEngine.create(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    return { store, engine }
}

describe('Pi conversation-history hub integration', () => {
    it('returns 409-style deterministic rewind rejection without marking history diverged', async () => {
        const { store, engine } = (await createEngine())
        try {
            const session = (await engine.getOrCreateSession('pi-rewind-rejected', {
                path: '/tmp/project', host: 'localhost', flavor: 'pi',
                capabilities: { conversationHistory: { rewindToMessage: true } },
            }, null, 'default'))
            await engine.handleSessionAlive({ sid: session.id, time: Date.now(), mode: 'remote' })
            await store.messages.addMessage(session.id, { role: 'user', content: 'boundary' }, 'local-boundary')
            await store.messages.markMessagesInvoked(session.id, ['local-boundary'], Date.now())
            ;(engine as any).rpcGateway.rewindConversation = async () => ({
                success: false,
                error: 'Codex native boundary is ambiguous',
                code: 'ambiguous_native_boundary',
                outcome: 'rejected',
            })

            await expect((engine.rewindConversation(session.id, 'default', 'local-boundary'))).resolves.toEqual({
                type: 'error', message: 'Codex native boundary is ambiguous', code: 'ambiguous_native_boundary',
            })
            expect((await engine.getSession(session.id))?.metadata?.conversationHistoryDiverged).not.toBe(true)
        } finally {
            await engine.stop()
        }
    })

    it('shares exact-native bind logic while requiring Pi native-ready but not Grok ready', async () => {
        const { engine } = (await createEngine())
        try {
            const pi = (await engine.getOrCreateSession('pi-child', {
                path: '/tmp/project', host: 'localhost', flavor: 'pi', piSessionId: 'pi-native',
            }, null, 'default'))
            const grok = (await engine.getOrCreateSession('grok-child', {
                path: '/tmp/project', host: 'localhost', flavor: 'grok', grokSessionId: 'grok-native',
            }, null, 'default'))

            const piWait = (engine as any).waitForExactNativeForkBound(
                pi.id, 'pi-native', 'piSessionId', true
            )
            expect(await (engine as any).waitForExactNativeForkBound(
                grok.id, 'grok-native', 'grokSessionId', false
            )).toBe(true)

            await engine.handleSessionReady({ sid: pi.id, time: Date.now() })
            expect(await piWait).toBe(true)
        } finally {
            await engine.stop()
        }
    })

    it('copies Pi entry-id locators into a fork child and requires exact native-ready binding', async () => {
        const { store, engine } = (await createEngine())
        try {
            const source = (await engine.getOrCreateSession('pi-source', {
                path: '/tmp/project',
                host: 'localhost',
                machineId: 'machine-1',
                flavor: 'pi',
                piSessionId: 'pi-source-native',
                summary: { text: 'Pi source title', updatedAt: 100 },
                capabilities: { conversationHistory: { forkCurrent: true, forkAtMessage: true, rewindToMessage: true } },
                conversationHistoryPoints: { local1: true, local2: true },
                conversationHistoryEntryIds: { local1: 'entry-1', local2: 'entry-2' },
            }, null, 'default', 'source-model', 'high'))
            await engine.handleSessionAlive({ sid: source.id, time: Date.now(), mode: 'remote' })
            await store.messages.addMessage(source.id, { role: 'user', content: 'one' }, 'local1')
            await store.messages.addMessage(source.id, { role: 'user', content: 'two' }, 'local2')
            await store.messages.markMessagesInvoked(source.id, ['local1', 'local2'], Date.now())
            // Keep the cache fixture explicit; this is the source used by the
            // fork prefix copy path after metadata normalization.
            ;((await engine.getSession(source.id))!.metadata as any).conversationHistoryEntryIds = {
                local1: 'entry-1', local2: 'entry-2',
            }

            ;(engine as any).rpcGateway.forkConversation = async () => {
                await store.messages.addMessage(source.id, { role: 'user', content: 'latest' }, 'local3')
                await store.messages.markMessagesInvoked(source.id, ['local3'], Date.now())
                const current = (await store.sessions.getSession(source.id))!
                await store.sessions.updateSessionMetadata(
                    source.id,
                    {
                        ...(current.metadata as Record<string, unknown>),
                        conversationHistoryPoints: { ...((current.metadata as any).conversationHistoryPoints), local3: true },
                        conversationHistoryEntryIds: { ...((current.metadata as any).conversationHistoryEntryIds), local3: 'entry-3' },
                    },
                    current.metadataVersion,
                    'default',
                    { touchUpdatedAt: false }
                )
                return { nativeSessionId: 'pi-clone-native' }
            }
            let spawnArgs: unknown[] = []
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => {
                spawnArgs = args
                return { type: 'success', sessionId: args[12] }
            }
            const exactBinds: unknown[][] = []
            ;(engine as any).waitForExactNativeForkBound = async (...args: unknown[]) => {
                exactBinds.push(args)
                return true
            }
            let capturedChildMetadata: Record<string, unknown> | undefined
            const cache = (engine as any).sessionCache
            const originalCreate = cache.getOrCreateSession.bind(cache)
            cache.getOrCreateSession = (...args: unknown[]) => {
                if (typeof args[0] === 'string' && args[0].startsWith('fork:')) {
                    capturedChildMetadata = args[1] as Record<string, unknown>
                }
                return originalCreate(...args)
            }

            const result = await engine.forkConversation(source.id, 'default')
            expect(result.type).toBe('success')
            if (result.type !== 'success') throw new Error(result.message)
            expect(capturedChildMetadata).toMatchObject({
                flavor: 'pi',
                piSessionId: 'pi-clone-native',
                summary: { text: 'Fork: Pi source title', updatedAt: expect.any(Number) },
                conversationHistoryEntryIds: { local1: 'entry-1', local2: 'entry-2', local3: 'entry-3' },
                conversationHistoryPoints: { local1: true, local2: true, local3: true },
            })
            expect((await store.messages.getAllMessages(result.sessionId)).map((message) => message.localId)).toContain('local3')
            expect((await engine.getSession(result.sessionId))?.metadata?.summary).toMatchObject({
                text: 'Fork: Pi source title',
                updatedAt: expect.any(Number),
            })
            expect(exactBinds).toEqual([[result.sessionId, 'pi-clone-native', 'piSessionId', true]])
            expect(spawnArgs[3]).toBeUndefined()
            expect(spawnArgs[9]).toBeUndefined()
            expect((await engine.getSession(result.sessionId))?.model).toBeNull()
            expect((await engine.getSession(result.sessionId))?.effort).toBeNull()
        } finally {
            await engine.stop()
        }
    })

    it('scrubs Pi entry-id locators when rewind truncates their HAPI messages', async () => {
        const { store, engine } = (await createEngine())
        try {
            const session = (await engine.getOrCreateSession('pi-scrub', {
                path: '/tmp/project', host: 'localhost', flavor: 'pi',
                conversationHistoryEntryIds: { keep: 'entry-keep', remove: 'entry-remove' },
                conversationHistoryPoints: { keep: true, remove: true },
            }, null, 'default'))
            await store.messages.addMessage(session.id, { role: 'user', content: 'keep' }, 'keep')
            ;((await engine.getSession(session.id))!.metadata as any).conversationHistoryEntryIds = {
                keep: 'entry-keep', remove: 'entry-remove',
            }
            let capturedMetadata: Record<string, unknown> | undefined
            const originalUpdate = store.sessions.updateSessionMetadata.bind(store.sessions)
            ;(store.sessions as any).updateSessionMetadata = (...args: unknown[]) => {
                capturedMetadata = args[1] as Record<string, unknown>
                return { result: 'success' }
            }
            await (engine as any).scrubHistoryLocators(session.id, 'default')
            ;(store.sessions as any).updateSessionMetadata = originalUpdate

            expect(capturedMetadata).toMatchObject({
                conversationHistoryEntryIds: { keep: 'entry-keep' },
                conversationHistoryPoints: { keep: true },
            })
        } finally {
            await engine.stop()
        }
    })
})
