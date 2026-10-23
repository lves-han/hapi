import { describe, expect, it, mock } from 'bun:test'
import { RpcRegistry } from '../socket/rpcRegistry'
import { Store } from '../store'
import { SyncEngine, type SyncEvent } from './syncEngine'

async function createEngine(onCliEmit?: (payload: unknown) => void) {
    const store = new Store(':memory:')
    const engine = await SyncEngine.create(store, {
        of: () => ({ to: () => ({ emit: (_event: string, payload: unknown) => onCliEmit?.(payload) }) })
    } as never, new RpcRegistry(), { broadcast() {} } as never)
    await engine.getOrCreateMachine(
        'machine-1',
        { host: 'host', platform: 'linux', happyCliVersion: 'test' },
        null,
        'default'
    )
    return { store, engine }
}

async function createClearSource(engine: SyncEngine, metadata: Record<string, unknown> = {}) {
    return (await engine.getOrCreateSession('clear-source', {
        path: '/tmp/project',
        host: 'host',
        machineId: 'machine-1',
        flavor: 'opencode',
        lifecycleState: 'archived',
        archiveReason: 'Cleared by /clear',
        preferredPermissionMode: 'yolo',
        opencodeSessionId: 'native-source-must-not-resume',
        ...metadata
    }, null, 'default', 'opencode/model', 'effort-x', 'high'))
}


async function currentReplacementId(engine: SyncEngine, sessionId: string): Promise<string> {
    const id = (await engine.getSessionByNamespace(sessionId, 'default'))?.metadata?.opencodeClearOperation?.replacementSessionId
    if (!id) throw new Error('clear reservation missing')
    return id
}

function setSpawn(engine: SyncEngine, spawnSession: ReturnType<typeof mock>) {
    ;(engine as unknown as { rpcGateway: { spawnSession: typeof spawnSession } }).rpcGateway.spawnSession = spawnSession
}

describe('SyncEngine.clearOpenCodeSession', () => {
    it.each(['resume', 'reopen'] as const)('allows %s after a failed native cleanup aborts clear', async (action) => {
        const { store, engine } = (await createEngine())
        try {
            const source = (await engine.getOrCreateSession(`abort-${action}`, {
                path: '/tmp/project', host: 'host', machineId: 'machine-1', flavor: 'opencode', startedBy: 'runner'
            }, null, 'default'))
            await engine.handleSessionAlive({ sid: source.id, time: Date.now() })
            expect((await engine.reserveOpenCodeClearSession(source.id, 'default'))).toMatchObject({ type: 'success' })
            expect((await engine.abortOpenCodeClearSession(source.id, 'default', (await currentReplacementId(engine, source.id))))).toMatchObject({ type: 'success' })
            const abortedMetadata = (await engine.getSessionByNamespace(source.id, 'default'))!.metadata!
            await engine.handleSessionEnd({ sid: source.id, time: Date.now(), reason: 'error' })
            const ended = (await store.sessions.getSessionByNamespace(source.id, 'default'))!
            await store.sessions.updateSessionMetadata(source.id, abortedMetadata, ended.metadataVersion, 'default')
            await (engine as unknown as { sessionCache: { refreshSession(id: string): unknown } }).sessionCache.refreshSession(source.id)
            setSpawn(engine, mock(async () => ({ type: 'success' as const, sessionId: source.id })))
            const result = action === 'resume'
                ? await engine.resumeSession(source.id, 'default')
                : await engine.reopenSession(source.id, 'default')
            expect(result).not.toMatchObject({ type: 'error', code: 'resume_unavailable' })
        } finally { await engine.stop() }
    })
    it('durably reserves a replacement while the source is active and reuses it after archival', async () => {
        const { store, engine } = (await createEngine())
        try {
            const source = (await engine.getOrCreateSession('active-clear-source', {
                path: '/tmp/project', host: 'host', machineId: 'machine-1', flavor: 'opencode', startedBy: 'runner'
            }, null, 'default'))
            await engine.handleSessionAlive({ sid: source.id, time: Date.now() })
            const reserved = (await engine.reserveOpenCodeClearSession(source.id, 'default'))
            expect(reserved.type).toBe('success')
            if (reserved.type !== 'success') throw new Error('reservation failed')
            expect(typeof reserved.sessionId).toBe('string')
            expect((await engine.getSessionByNamespace(source.id, 'default'))?.metadata?.opencodeClearOperation).toMatchObject({
                replacementSessionId: reserved.sessionId, state: 'reserved'
            })
            expect((await engine.confirmOpenCodeClearCleanup(source.id, 'default', (await currentReplacementId(engine, source.id))))).toMatchObject({ type: 'success' })
            const metadataBeforeEnd = (await engine.getSessionByNamespace(source.id, 'default'))!.metadata!
            await engine.handleSessionEnd({ sid: source.id, time: Date.now(), reason: 'cleared' })
            const storedAfterEnd = (await store.sessions.getSessionByNamespace(source.id, 'default'))!
            await store.sessions.updateSessionMetadata(source.id, { ...metadataBeforeEnd, lifecycleState: 'archived', archiveReason: 'Cleared by /clear' }, storedAfterEnd.metadataVersion, 'default')
            await (engine as unknown as { sessionCache: { refreshSession(id: string): unknown } }).sessionCache.refreshSession(source.id)
            const spawnSession = mock(async (...args: unknown[]) => ({ type: 'success' as const, sessionId: args[12] as string }))
            setSpawn(engine, spawnSession)
            await expect((engine.clearOpenCodeSession(source.id, 'default'))).resolves.toEqual({ type: 'success', sessionId: reserved.sessionId })
        } finally { await engine.stop() }
    })

    it('atomically redirects messages arriving after reservation to the replacement', async () => {
        const { store, engine } = (await createEngine())
        try {
            const source = (await engine.getOrCreateSession('active-clear-source', {
                path: '/tmp/project', host: 'host', machineId: 'machine-1', flavor: 'opencode', startedBy: 'runner'
            }, null, 'default'))
            await engine.handleSessionAlive({ sid: source.id, time: Date.now() })
            const reserved = (await engine.reserveOpenCodeClearSession(source.id, 'default'))
            if (reserved.type !== 'success') throw new Error('reservation failed')
            await engine.sendMessage(source.id, { text: 'late immediate', localId: 'late-immediate' })
            await engine.sendMessage(source.id, { text: 'late scheduled', localId: 'late-scheduled', scheduledAt: Date.now() + 60_000 })
            expect((await store.messages.getAllMessages(source.id))).toEqual([])
            expect((await store.messages.getAllMessages(reserved.sessionId)).map((m) => m.localId)).toEqual(['late-immediate', 'late-scheduled'])
        } finally { await engine.stop() }
    })

    it('preserves FIFO from a source prompt before reservation to a redirected target prompt', async () => {
        const { store, engine } = (await createEngine())
        try {
            const source = (await engine.getOrCreateSession('reservation-boundary-fifo', {
                path: '/tmp/project', host: 'host', machineId: 'machine-1', flavor: 'opencode', startedBy: 'runner'
            }, null, 'default'))
            await engine.handleSessionAlive({ sid: source.id, time: Date.now() })
            await store.messages.addMessage(source.id, { text: 'A before reservation' }, 'fifo-a')
            const reserved = (await engine.reserveOpenCodeClearSession(source.id, 'default'))
            if (reserved.type !== 'success') throw new Error('reservation failed')
            await engine.sendMessage(source.id, { text: 'B after reservation', localId: 'fifo-b' })
            expect((await engine.confirmOpenCodeClearCleanup(source.id, 'default', reserved.sessionId))).toMatchObject({ type: 'success' })
            await engine.handleSessionEnd({ sid: source.id, time: Date.now(), reason: 'cleared' })
            setSpawn(engine, mock(async (...args: unknown[]) => ({ type: 'success' as const, sessionId: args[12] as string })))

            await (engine as unknown as { reconcileOpenCodeClears(): Promise<void> }).reconcileOpenCodeClears()

            expect((await store.messages.getAllMessages(reserved.sessionId)).map((message) => message.localId)).toEqual(['fifo-a', 'fifo-b'])
            expect((await store.messages.getAllMessages(source.id))).toEqual([])
        } finally { await engine.stop() }
    })

    it('gates replacement delivery during spawn and releases finalized FIFO after linking', async () => {
        const emitted: Array<{ body?: { message?: { localId?: string | null } } }> = []
        const { store, engine } = (await createEngine((payload) => emitted.push(payload as typeof emitted[number])))
        try {
            const source = (await engine.getOrCreateSession('spawn-delivery-gate', {
                path: '/tmp/project', host: 'host', machineId: 'machine-1', flavor: 'opencode', startedBy: 'runner'
            }, null, 'default'))
            await engine.handleSessionAlive({ sid: source.id, time: Date.now() })
            emitted.length = 0
            await store.messages.addMessage(source.id, { text: 'A before reservation' }, 'gated-a')
            const reserved = (await engine.reserveOpenCodeClearSession(source.id, 'default'))
            if (reserved.type !== 'success') throw new Error('reservation failed')
            await engine.sendMessage(source.id, { text: 'B after reservation', localId: 'gated-b' })
            await store.messages.addMessage(reserved.sessionId, { text: 'mature but gated' }, 'gated-scheduled', Date.now() - 1)
            expect((await engine.confirmOpenCodeClearCleanup(source.id, 'default', reserved.sessionId))).toMatchObject({ type: 'success' })
            await engine.handleSessionEnd({ sid: source.id, time: Date.now(), reason: 'cleared' })
            let releaseSpawn!: () => void
            let spawnStarted = false
            const spawnWait = new Promise<void>((resolve) => { releaseSpawn = resolve })
            setSpawn(engine, mock(async (...args: unknown[]) => {
                spawnStarted = true
                await spawnWait
                return { type: 'success' as const, sessionId: args[12] as string }
            }))

            const reconcile = ((engine as unknown as { reconcileOpenCodeClears(): Promise<void> }).reconcileOpenCodeClears())
            while (!spawnStarted) await Promise.resolve()
            expect((await store.isOpenCodeClearDeliveryGated(reserved.sessionId))).toBe(true)
            await engine.handleSessionAlive({ sid: reserved.sessionId, time: Date.now() })
            await engine.handleSessionAlive({ sid: reserved.sessionId, time: Date.now() + 1 })
            ;(engine as unknown as { messageService: { releaseMatureScheduledMessages(now: number): void } })
                .messageService.releaseMatureScheduledMessages(Date.now())
            expect(emitted.filter((update) => update.body?.message)).toEqual([])

            releaseSpawn()
            await reconcile
            expect((await store.isOpenCodeClearDeliveryGated(reserved.sessionId))).toBe(false)
            expect(emitted.filter((update) => update.body?.message).map((update) => update.body?.message?.localId)).toEqual([
                'gated-a', 'gated-b', 'gated-scheduled'
            ])
        } finally { await engine.stop() }
    })

    it.each([
        ['supersededBySessionId', 'foreign'],
        ['opencodeClearOperation', 'foreign'],
        ['supersededBySessionId', 'missing'],
        ['opencodeClearOperation', 'missing']
    ] as const)('fails closed for a forged %s redirect to a %s target', async (field, targetKind) => {
        const { store, engine } = (await createEngine())
        try {
            const source = (await engine.getOrCreateSession(`forged-${field}-${targetKind}`, {
                path: '/tmp/project', host: 'host', flavor: 'opencode'
            }, null, 'default'))
            await engine.handleSessionAlive({ sid: source.id, time: Date.now() })
            const targetId = `target-${field}-${targetKind}`
            if (targetKind === 'foreign') {
                await engine.getOrCreateSession(`foreign-${field}`, { path: '/tmp/foreign', host: 'host' }, null, 'other', undefined, undefined, undefined, targetId)
            }
            const stored = (await store.sessions.getSessionByNamespace(source.id, 'default'))!
            const redirect = field === 'supersededBySessionId'
                ? { supersededBySessionId: targetId }
                : { opencodeClearOperation: { replacementSessionId: targetId, state: 'reserved', updatedAt: Date.now() } }
            await store.sessions.updateSessionMetadata(source.id, {
                ...(stored.metadata as Record<string, unknown>), ...redirect
            }, stored.metadataVersion, 'default')
            const events: SyncEvent[] = []
            engine.subscribe((event) => events.push(event))

            await expect(engine.sendMessage(source.id, { text: 'must not cross namespace', localId: 'forged-local' })).rejects.toThrow(
                'redirect target is unavailable'
            )

            expect((await store.messages.getAllMessages(source.id))).toEqual([])
            if (targetKind === 'foreign') expect((await store.messages.getAllMessages(targetId))).toEqual([])
            expect(events).not.toContainEqual(expect.objectContaining({ type: 'message-received' }))
        } finally { await engine.stop() }
    })

    it.each(['supersededBySessionId', 'opencodeClearOperation'] as const)(
        'allows a same-namespace %s redirect',
        async (field) => {
            const { store, engine } = (await createEngine())
            try {
                const source = (await engine.getOrCreateSession(`same-namespace-${field}`, { path: '/tmp/project', host: 'host' }, null, 'default'))
                const target = (await engine.getOrCreateSession(`same-target-${field}`, { path: '/tmp/project', host: 'host' }, null, 'default'))
                const stored = (await store.sessions.getSessionByNamespace(source.id, 'default'))!
                const redirect = field === 'supersededBySessionId'
                    ? { supersededBySessionId: target.id }
                    : { opencodeClearOperation: { replacementSessionId: target.id, state: 'reserved', updatedAt: Date.now() } }
                await store.sessions.updateSessionMetadata(source.id, {
                    ...(stored.metadata as Record<string, unknown>), ...redirect
                }, stored.metadataVersion, 'default')
                await engine.sendMessage(source.id, { text: 'same namespace', localId: `same-${field}` })
                expect((await store.messages.getAllMessages(source.id))).toEqual([])
                expect((await store.messages.getAllMessages(target.id))).toEqual([
                    expect.objectContaining({ localId: `same-${field}`, invokedAt: null })
                ])
            } finally { await engine.stop() }
        }
    )

    it('recovers cleanup-confirmed clear when the CLI dies before writing archive metadata', async () => {
        const { engine } = (await createEngine())
        try {
            const source = (await engine.getOrCreateSession('crashed-clear-source', {
                path: '/tmp/project', host: 'host', machineId: 'machine-1', flavor: 'opencode', startedBy: 'runner'
            }, null, 'default'))
            await engine.handleSessionAlive({ sid: source.id, time: Date.now() })
            const reserved = (await engine.reserveOpenCodeClearSession(source.id, 'default'))
            if (reserved.type !== 'success') throw new Error('reservation failed')
            expect((await engine.confirmOpenCodeClearCleanup(source.id, 'default', (await currentReplacementId(engine, source.id))))).toMatchObject({ type: 'success' })
            await engine.handleSessionEnd({ sid: source.id, time: Date.now(), reason: 'error' })
            const spawnSession = mock(async (...args: unknown[]) => ({ type: 'success' as const, sessionId: args[12] as string }))
            setSpawn(engine, spawnSession)
            await (engine as unknown as { reconcileOpenCodeClears(): Promise<void> }).reconcileOpenCodeClears()
            expect((await engine.getSessionByNamespace(source.id, 'default'))?.metadata).toMatchObject({
                lifecycleState: 'archived', archiveReason: 'Cleared by /clear', supersededBySessionId: reserved.sessionId
            })
            expect(spawnSession).toHaveBeenCalledTimes(1)
        } finally { await engine.stop() }
    })

    it('recovers a persisted pending spawn with the exact replacement identity after restart', async () => {
        const { engine } = (await createEngine())
        try {
            const replacementSessionId = 'pending-before-spawn'
            const source = (await createClearSource(engine, {
                opencodeClearOperation: {
                    replacementSessionId,
                    state: 'pending',
                    updatedAt: Date.now()
                }
            }))
            const spawnSession = mock(async (...args: unknown[]) => ({
                type: 'success' as const,
                sessionId: args[12] as string
            }))
            setSpawn(engine, spawnSession)

            await (engine as unknown as { reconcileOpenCodeClears(): Promise<void> }).reconcileOpenCodeClears()

            expect(spawnSession).toHaveBeenCalledTimes(1)
            expect(spawnSession.mock.calls[0]?.[12]).toBe(replacementSessionId)
            expect((await engine.getSessionByNamespace(source.id, 'default'))?.metadata).toMatchObject({
                supersededBySessionId: replacementSessionId,
                opencodeClearOperation: { replacementSessionId, state: 'completed' }
            })
        } finally { await engine.stop() }
    })

    it('safely aborts an inactive unconfirmed reservation and restores held messages', async () => {
        const { store, engine } = (await createEngine())
        try {
            const source = (await engine.getOrCreateSession('unconfirmed-clear-source', {
                path: '/tmp/project', host: 'host', machineId: 'machine-1', flavor: 'opencode', startedBy: 'runner'
            }, null, 'default'))
            await engine.handleSessionAlive({ sid: source.id, time: Date.now() })
            expect((await engine.reserveOpenCodeClearSession(source.id, 'default'))).toMatchObject({ type: 'success' })
            await engine.sendMessage(source.id, { text: 'held during lost response', localId: 'lost-response-held' })
            await engine.handleSessionEnd({ sid: source.id, time: Date.now(), reason: 'error' })
            const spawnSession = mock(async () => ({ type: 'success' as const, sessionId: 'must-not-spawn' }))
            setSpawn(engine, spawnSession)
            await (engine as unknown as { reconcileOpenCodeClears(): Promise<void> }).reconcileOpenCodeClears()
            expect(spawnSession).not.toHaveBeenCalled()
            expect((await engine.getSessionByNamespace(source.id, 'default'))?.metadata?.opencodeClearOperation?.state).toBe('aborted')
            expect((await store.messages.getAllMessages(source.id))).toEqual([
                expect.objectContaining({ localId: 'lost-response-held', invokedAt: null })
            ])
            expect((engine as unknown as { isOpenCodeClearSource(session: unknown): boolean }).isOpenCodeClearSource(
                (await engine.getSessionByNamespace(source.id, 'default'))!
            )).toBe(false)
        } finally { await engine.stop() }
    })

    it('does not treat heartbeat expiry as process-death proof for a live reservation', async () => {
        const { store, engine } = (await createEngine())
        try {
            const source = (await engine.getOrCreateSession('heartbeat-expired-reservation', {
                path: '/tmp/project', host: 'host', machineId: 'machine-1', flavor: 'opencode', startedBy: 'runner'
            }, null, 'default'))
            await engine.handleSessionAlive({ sid: source.id, time: Date.now() - 120_000 })
            expect((await engine.reserveOpenCodeClearSession(source.id, 'default'))).toMatchObject({ type: 'success' })
            await engine.sendMessage(source.id, { text: 'still owned', localId: 'still-owned' })
            const cached = (await engine.getSessionByNamespace(source.id, 'default')) as unknown as { activeAt: number }
            cached.activeAt = Date.now() - 120_000
            const spawnSession = mock(async () => ({ type: 'success' as const, sessionId: 'must-not-spawn' }))
            setSpawn(engine, spawnSession)
            ;(engine as unknown as { expireInactive(): void }).expireInactive()
            await (engine as unknown as { reconcileOpenCodeClears(): Promise<void> }).reconcileOpenCodeClears()
            expect((await engine.getSessionByNamespace(source.id, 'default'))?.active).toBe(false)
            expect((await engine.getSessionByNamespace(source.id, 'default'))?.metadata?.opencodeClearOperation?.state).toBe('reserved')
            expect((await store.messages.getAllMessages(source.id))).toEqual([])
            expect(spawnSession).not.toHaveBeenCalled()
            const gateway = (engine as unknown as { rpcGateway: { stopRunnerSession: ReturnType<typeof mock> } }).rpcGateway
            gateway.stopRunnerSession = mock(async () => 'still_alive' as const)
            await expect((engine.resumeSession(source.id, 'default'))).resolves.toMatchObject({ type: 'error', code: 'resume_unavailable' })
            gateway.stopRunnerSession = mock(async () => 'already_gone' as const)
            expect(await (engine as unknown as { recoverInactiveReservedClear(session: unknown, namespace: string): Promise<boolean> })
                .recoverInactiveReservedClear((await engine.getSessionByNamespace(source.id, 'default'))!, 'default')).toBe(true)
            expect((await engine.getSessionByNamespace(source.id, 'default'))?.metadata?.opencodeClearOperation?.state).toBe('aborted')
            expect((engine as unknown as { isOpenCodeClearSource(session: unknown): boolean }).isOpenCodeClearSource(
                (await engine.getSessionByNamespace(source.id, 'default'))!
            )).toBe(false)
            expect((await store.messages.getAllMessages(source.id))).toEqual([
                expect.objectContaining({ localId: 'still-owned', invokedAt: null })
            ])
        } finally { await engine.stop() }
    })

    it.each(['confirm', 'reactivate'] as const)('does not abort when %s wins during StopSession await', async (winner) => {
        const { engine } = (await createEngine())
        try {
            const source = (await engine.getOrCreateSession(`stop-race-${winner}`, {
                path: '/tmp/project', host: 'host', machineId: 'machine-1', flavor: 'opencode', startedBy: 'runner'
            }, null, 'default'))
            await engine.handleSessionAlive({ sid: source.id, time: Date.now() })
            const reserved = (await engine.reserveOpenCodeClearSession(source.id, 'default'))
            if (reserved.type !== 'success') throw new Error('reservation failed')
            const cached = (await engine.getSessionByNamespace(source.id, 'default')) as unknown as { activeAt: number }
            cached.activeAt = Date.now() - 120_000
            ;(engine as unknown as { expireInactive(): void }).expireInactive()
            let release!: () => void
            const stop = new Promise<void>((resolve) => { release = resolve })
            ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession = mock(async () => {
                await stop
                return 'already_gone' as const
            })
            const recovery = ((engine as unknown as { recoverInactiveReservedClear(session: unknown, namespace: string): Promise<boolean> })
                .recoverInactiveReservedClear((await engine.getSessionByNamespace(source.id, 'default'))!, 'default'))
            await Promise.resolve()
            if (winner === 'confirm') {
                expect((await engine.confirmOpenCodeClearCleanup(source.id, 'default', (await currentReplacementId(engine, source.id))))).toMatchObject({ type: 'success' })
            } else {
                await engine.handleSessionAlive({ sid: source.id, time: Date.now() })
            }
            release()
            expect(await recovery).toBe(false)
            expect((await engine.getSessionByNamespace(source.id, 'default'))?.metadata?.opencodeClearOperation?.state)
                .toBe(winner === 'confirm' ? 'cleanup-confirmed' : 'reserved')
        } finally { await engine.stop() }
    })

    it('rejects a delayed cleanup confirmation after explicit exit owns the abort', async () => {
        const { store, engine } = (await createEngine())
        try {
            const source = (await engine.getOrCreateSession('confirm-after-exit', {
                path: '/tmp/project', host: 'host', machineId: 'machine-1', flavor: 'opencode', startedBy: 'runner'
            }, null, 'default'))
            await engine.handleSessionAlive({ sid: source.id, time: Date.now() })
            expect((await engine.reserveOpenCodeClearSession(source.id, 'default'))).toMatchObject({ type: 'success' })
            const original = store.abortOpenCodeClearOperation.bind(store)
            store.abortOpenCodeClearOperation = (async () => ({ result: 'error' as const })) as typeof original
            await engine.handleSessionEnd({ sid: source.id, time: Date.now(), reason: 'error' })
            expect((await engine.getSessionByNamespace(source.id, 'default'))?.metadata?.opencodeClearOperation?.state).toBe('abort-needed')
            expect((await engine.confirmOpenCodeClearCleanup(source.id, 'default', (await currentReplacementId(engine, source.id))))).toMatchObject({ type: 'error' })
            expect((await engine.getSessionByNamespace(source.id, 'default'))?.metadata?.opencodeClearOperation?.state).toBe('abort-needed')
        } finally { await engine.stop() }
    })

    it('rejects a delayed cleanup-failure abort after cleanup confirmation', async () => {
        const { engine } = (await createEngine())
        try {
            const source = (await engine.getOrCreateSession('abort-after-confirm', {
                path: '/tmp/project', host: 'host', machineId: 'machine-1', flavor: 'opencode', startedBy: 'runner'
            }, null, 'default'))
            await engine.handleSessionAlive({ sid: source.id, time: Date.now() })
            expect((await engine.reserveOpenCodeClearSession(source.id, 'default'))).toMatchObject({ type: 'success' })
            expect((await engine.confirmOpenCodeClearCleanup(source.id, 'default', (await currentReplacementId(engine, source.id))))).toMatchObject({ type: 'success' })
            expect((await engine.abortOpenCodeClearSession(source.id, 'default', (await currentReplacementId(engine, source.id))))).toMatchObject({ type: 'error' })
            expect((await engine.getSessionByNamespace(source.id, 'default'))?.metadata?.opencodeClearOperation?.state).toBe('cleanup-confirmed')
        } finally { await engine.stop() }
    })

    it('does not confirm a stale reservation identity', async () => {
        const { store, engine } = (await createEngine())
        try {
            const source = (await engine.getOrCreateSession('stale-confirm-identity', {
                path: '/tmp/project', host: 'host', machineId: 'machine-1', flavor: 'opencode', startedBy: 'runner'
            }, null, 'default'))
            await engine.handleSessionAlive({ sid: source.id, time: Date.now() })
            expect((await engine.reserveOpenCodeClearSession(source.id, 'default'))).toMatchObject({ type: 'success' })
            const stored = (await store.sessions.getSessionByNamespace(source.id, 'default'))!
            await store.sessions.updateSessionMetadata(source.id, {
                ...(stored.metadata as Record<string, unknown>),
                opencodeClearOperation: { replacementSessionId: 'new-owner', state: 'reserved', updatedAt: Date.now() }
            }, stored.metadataVersion, 'default')
            expect((await engine.confirmOpenCodeClearCleanup(source.id, 'default', (await currentReplacementId(engine, source.id))))).toMatchObject({ type: 'error' })
            const persisted = (await store.sessions.getSessionByNamespace(source.id, 'default'))?.metadata as Record<string, unknown>
            expect(persisted.opencodeClearOperation).toMatchObject({
                replacementSessionId: 'new-owner', state: 'reserved'
            })
        } finally { await engine.stop() }
    })

    it('treats a lost cleanup-confirm success response as an idempotent retry', async () => {
        const { store, engine } = (await createEngine())
        try {
            const source = (await engine.getOrCreateSession('lost-confirm-response', {
                path: '/tmp/project', host: 'host', machineId: 'machine-1', flavor: 'opencode', startedBy: 'runner'
            }, null, 'default'))
            await engine.handleSessionAlive({ sid: source.id, time: Date.now() })
            const reserved = (await engine.reserveOpenCodeClearSession(source.id, 'default'))
            if (reserved.type !== 'success') throw new Error('reservation failed')
            const original = store.transitionOpenCodeClearOperation.bind(store)
            let loseResponse = true
            store.transitionOpenCodeClearOperation = (async (...args: Parameters<typeof original>) => {
                const result = (await original(...args))
                if (loseResponse && result.result === 'success') {
                    loseResponse = false
                    return { result: 'version-mismatch' as const }
                }
                return result
            }) as typeof store.transitionOpenCodeClearOperation
            expect((await engine.confirmOpenCodeClearCleanup(source.id, 'default', (await currentReplacementId(engine, source.id))))).toEqual({
                type: 'success', sessionId: reserved.sessionId
            })
            expect((await engine.confirmOpenCodeClearCleanup(source.id, 'default', (await currentReplacementId(engine, source.id))))).toEqual({
                type: 'success', sessionId: reserved.sessionId
            })
        } finally { await engine.stop() }
    })

    it('treats a lost abort success response as an idempotent retry', async () => {
        const { store, engine } = (await createEngine())
        try {
            const source = (await engine.getOrCreateSession('lost-abort-response', {
                path: '/tmp/project', host: 'host', machineId: 'machine-1', flavor: 'opencode', startedBy: 'runner'
            }, null, 'default'))
            await engine.handleSessionAlive({ sid: source.id, time: Date.now() })
            expect((await engine.reserveOpenCodeClearSession(source.id, 'default'))).toMatchObject({ type: 'success' })
            await engine.sendMessage(source.id, { text: 'restore once', localId: 'restore-once' })
            const original = store.abortOpenCodeClearOperation.bind(store)
            let loseResponse = true
            store.abortOpenCodeClearOperation = (async (...args: Parameters<typeof original>) => {
                const result = (await original(...args))
                if (loseResponse && result.result === 'success') {
                    loseResponse = false
                    return { result: 'version-mismatch' as const }
                }
                return result
            }) as typeof store.abortOpenCodeClearOperation
            const replacementId = (await currentReplacementId(engine, source.id))
            expect((await engine.getSessionByNamespace(replacementId, 'default'))?.hasConversationContent).toBe(true)
            expect((await engine.abortOpenCodeClearSession(source.id, 'default', replacementId))).toEqual({ type: 'success', sessionId: source.id })
            expect((await engine.getSessionByNamespace(source.id, 'default'))?.hasConversationContent).toBe(true)
            expect((await engine.getSessionByNamespace(replacementId, 'default'))?.hasConversationContent).toBe(false)
            expect((await engine.abortOpenCodeClearSession(source.id, 'default', replacementId))).toEqual({ type: 'success', sessionId: source.id })
            expect((await engine.getSessionByNamespace(replacementId, 'default'))?.hasConversationContent).toBe(false)
            expect((await store.messages.getAllMessages(source.id))).toEqual([
                expect.objectContaining({ localId: 'restore-once', invokedAt: null })
            ])
        } finally { await engine.stop() }
    })

    it.each(['confirm', 'abort'] as const)('does not let delayed reservation A %s mutate reservation B', async (callback) => {
        const { engine } = (await createEngine())
        try {
            const source = (await engine.getOrCreateSession(`stale-a-${callback}`, {
                path: '/tmp/project', host: 'host', machineId: 'machine-1', flavor: 'opencode', startedBy: 'runner'
            }, null, 'default'))
            await engine.handleSessionAlive({ sid: source.id, time: Date.now() })
            const first = (await engine.reserveOpenCodeClearSession(source.id, 'default'))
            if (first.type !== 'success') throw new Error('first reservation failed')
            expect((await engine.abortOpenCodeClearSession(source.id, 'default', first.sessionId))).toMatchObject({ type: 'success' })
            const second = (await engine.reserveOpenCodeClearSession(source.id, 'default'))
            if (second.type !== 'success') throw new Error('second reservation failed')
            const result = callback === 'confirm'
                ? (await engine.confirmOpenCodeClearCleanup(source.id, 'default', first.sessionId))
                : (await engine.abortOpenCodeClearSession(source.id, 'default', first.sessionId))
            expect(result).toMatchObject({ type: 'error' })
            expect((await engine.getSessionByNamespace(source.id, 'default'))?.metadata?.opencodeClearOperation).toMatchObject({
                replacementSessionId: second.sessionId,
                state: 'reserved'
            })
        } finally { await engine.stop() }
    })

    it('aborts a reservation after native cleanup failure and restores held rows to the source', async () => {
        const { store, engine } = (await createEngine())
        try {
            const source = (await engine.getOrCreateSession('abort-clear-source', {
                path: '/tmp/project', host: 'host', machineId: 'machine-1', flavor: 'opencode', startedBy: 'runner'
            }, null, 'default'))
            await engine.handleSessionAlive({ sid: source.id, time: Date.now() })
            const reserved = (await engine.reserveOpenCodeClearSession(source.id, 'default'))
            if (reserved.type !== 'success') throw new Error('reservation failed')
            await engine.sendMessage(source.id, { text: 'held', localId: 'held' })
            expect((await store.messages.getAllMessages(reserved.sessionId))).toHaveLength(1)
            expect((await store.isOpenCodeClearDeliveryGated(reserved.sessionId))).toBe(true)
            expect((await engine.getSessionByNamespace(source.id, 'default'))?.hasConversationContent).toBe(false)
            expect((await engine.getSessionByNamespace(reserved.sessionId, 'default'))?.hasConversationContent).toBe(true)
            expect((await engine.abortOpenCodeClearSession(source.id, 'default', (await currentReplacementId(engine, source.id))))).toEqual({ type: 'success', sessionId: source.id })
            expect((await store.isOpenCodeClearDeliveryGated(reserved.sessionId))).toBe(false)
            expect((await engine.getSessionByNamespace(source.id, 'default'))?.hasConversationContent).toBe(true)
            expect((await engine.getSessionByNamespace(reserved.sessionId, 'default'))?.hasConversationContent).toBe(false)
            expect((await store.messages.getAllMessages(source.id)).map((m) => m.localId)).toEqual(['held'])
            expect((await engine.getSessionByNamespace(source.id, 'default'))?.metadata?.opencodeClearOperation?.state).toBe('aborted')
            await engine.handleSessionEnd({ sid: source.id, time: Date.now(), reason: 'error' })
            expect((engine as unknown as { isOpenCodeClearSource(session: unknown): boolean }).isOpenCodeClearSource(
                (await engine.getSessionByNamespace(source.id, 'default'))!
            )).toBe(false)
        } finally { await engine.stop() }
    })

    it('durably retries an explicit-exit abort after a metadata write failure', async () => {
        const { store, engine } = (await createEngine())
        try {
            const source = (await engine.getOrCreateSession('abort-retry-source', {
                path: '/tmp/project', host: 'host', machineId: 'machine-1', flavor: 'opencode', startedBy: 'runner',
                lifecycleState: 'archived', archiveReason: 'Archived before clear abort'
            }, null, 'default'))
            await engine.handleSessionAlive({ sid: source.id, time: Date.now() })
            expect((await engine.reserveOpenCodeClearSession(source.id, 'default'))).toMatchObject({ type: 'success' })
            await engine.sendMessage(source.id, { text: 'restore atomically', localId: 'atomic-held' })
            const original = store.abortOpenCodeClearOperation.bind(store)
            let fail = true
            store.abortOpenCodeClearOperation = (async (...args: Parameters<typeof original>) => {
                if (fail) return { result: 'not-found' as const }
                return (await original(...args))
            }) as typeof store.abortOpenCodeClearOperation
            await engine.handleSessionEnd({ sid: source.id, time: Date.now(), reason: 'error' })
            expect((await store.messages.getAllMessages(source.id))).toEqual([])
            expect((await engine.getSessionByNamespace(source.id, 'default'))?.metadata?.opencodeClearOperation?.state).toBe('abort-needed')
            fail = false
            await (engine as unknown as { reconcileOpenCodeClears(): Promise<void> }).reconcileOpenCodeClears()
            expect((await engine.getSessionByNamespace(source.id, 'default'))?.metadata?.opencodeClearOperation?.state).toBe('aborted')
            expect((await store.messages.getAllMessages(source.id))).toEqual([
                expect.objectContaining({ localId: 'atomic-held', invokedAt: null })
            ])
        } finally { await engine.stop() }
    })

    it('re-reserves an aborted operation with a fresh durable identity', async () => {
        const { engine } = (await createEngine())
        try {
            const source = (await engine.getOrCreateSession('retry-clear-source', {
                path: '/tmp/project', host: 'host', machineId: 'machine-1', flavor: 'opencode', startedBy: 'runner'
            }, null, 'default'))
            await engine.handleSessionAlive({ sid: source.id, time: Date.now() })
            const first = (await engine.reserveOpenCodeClearSession(source.id, 'default'))
            if (first.type !== 'success') throw new Error('reservation failed')
            expect((await engine.abortOpenCodeClearSession(source.id, 'default', (await currentReplacementId(engine, source.id))))).toMatchObject({ type: 'success' })
            const second = (await engine.reserveOpenCodeClearSession(source.id, 'default'))
            expect(second).toMatchObject({ type: 'success', sessionId: expect.any(String) })
            if (second.type !== 'success') throw new Error('re-reservation failed')
            expect(second.sessionId).not.toBe(first.sessionId)
            expect((await engine.getSessionByNamespace(source.id, 'default'))?.metadata?.opencodeClearOperation).toMatchObject({
                replacementSessionId: second.sessionId, state: 'reserved'
            })
        } finally { await engine.stop() }
    })
    it.each(['resume', 'reopen'] as const)('blocks %s of an archived clear source before spawning', async (action) => {
        const { engine } = (await createEngine())
        try {
            const source = (await createClearSource(engine))
            const spawnSession = mock(async () => ({ type: 'success' as const, sessionId: 'must-not-spawn' }))
            setSpawn(engine, spawnSession)

            const result = action === 'resume'
                ? await engine.resumeSession(source.id, 'default')
                : await engine.reopenSession(source.id, 'default')

            expect(result).toMatchObject({ type: 'error', code: 'resume_unavailable' })
            expect(spawnSession).not.toHaveBeenCalled()
            expect((await engine.getSessionByNamespace(source.id, 'default'))?.metadata).toMatchObject({
                lifecycleState: 'archived',
                archiveReason: 'Cleared by /clear'
            })
        } finally {
            await engine.stop()
        }
    })

    it('persists a preallocated replacement before spawning, preserving launch settings but never native source identity', async () => {
        const { engine } = (await createEngine())
        try {
            const source = (await createClearSource(engine))
            let operationAtSpawn: { replacementSessionId: string } | undefined
            const spawnSession = mock(async (...args: unknown[]) => {
                operationAtSpawn = (await engine.getSessionByNamespace(source.id, 'default'))?.metadata?.opencodeClearOperation
                return {
                    type: 'success' as const,
                    sessionId: args[12] as string
                }
            })
            setSpawn(engine, spawnSession)

            await expect((engine.clearOpenCodeSession(source.id, 'default'))).resolves.toMatchObject({
                type: 'success',
                sessionId: expect.any(String)
            })
            const replacementSessionId = spawnSession.mock.calls[0]?.[12] as string
            expect(replacementSessionId).toEqual(expect.any(String))
            expect(operationAtSpawn?.replacementSessionId).toBe(replacementSessionId)
            expect(replacementSessionId).not.toBe(source.id)
            expect(spawnSession).toHaveBeenCalledWith(
                'machine-1',
                '/tmp/project',
                'opencode',
                'opencode/model',
                'high',
                false,
                undefined,
                undefined,
                undefined,
                'effort-x',
                'yolo',
                undefined,
                replacementSessionId,
                undefined,
                undefined,
                // startingMode — not applicable to an OpenCode clear replacement
                undefined,
                // forkSession / reservedSessionId — clear uses reopen existingSessionId
                undefined,
                undefined
            )
            expect((await engine.getSessionByNamespace(replacementSessionId, 'default'))?.metadata).toMatchObject({
                flavor: 'opencode',
                path: '/tmp/project'
            })
            expect((await engine.getSessionByNamespace(replacementSessionId, 'default'))?.metadata?.opencodeSessionId).toBeUndefined()
            expect((await engine.getSessionByNamespace(source.id, 'default'))?.metadata).toMatchObject({
                supersededBySessionId: replacementSessionId
            })
        } finally {
            await engine.stop()
        }
    })

    it('reserves an independent replacement row for each cleared source', async () => {
        const { engine } = (await createEngine())
        try {
            const first = (await createClearSource(engine))
            const second = (await engine.getOrCreateSession('another-clear-source', {
                path: '/tmp/another-project', host: 'host', machineId: 'machine-1', flavor: 'opencode',
                lifecycleState: 'archived', archiveReason: 'Cleared by /clear'
            }, null, 'default'))
            const spawnSession = mock(async (...args: unknown[]) => ({ type: 'success' as const, sessionId: args[12] as string }))
            setSpawn(engine, spawnSession)

            const firstResult = await engine.clearOpenCodeSession(first.id, 'default')
            const secondResult = await engine.clearOpenCodeSession(second.id, 'default')
            expect(firstResult).toMatchObject({ type: 'success' })
            expect(secondResult).toMatchObject({ type: 'success' })
            if (firstResult.type !== 'success' || secondResult.type !== 'success') throw new Error('expected successful clears')
            expect(firstResult.sessionId).not.toBe(secondResult.sessionId)
        } finally {
            await engine.stop()
        }
    })

    it('retries a failed spawn against the same durable replacement id', async () => {
        const { engine } = (await createEngine())
        try {
            const source = (await createClearSource(engine))
            const firstSpawn = mock(async () => ({ type: 'error' as const, message: 'runner unavailable' }))
            setSpawn(engine, firstSpawn)
            await expect((engine.clearOpenCodeSession(source.id, 'default'))).resolves.toMatchObject({
                type: 'error', code: 'spawn_failed'
            })

            const pendingId = (await engine.getSessionByNamespace(source.id, 'default'))?.metadata?.opencodeClearOperation?.replacementSessionId
            expect(pendingId).toEqual(expect.any(String))
            if (!pendingId) throw new Error('expected durable replacement id')
            const secondSpawn = mock(async (...args: unknown[]) => ({ type: 'success' as const, sessionId: args[12] as string }))
            setSpawn(engine, secondSpawn)
            await expect((engine.clearOpenCodeSession(source.id, 'default'))).resolves.toEqual({
                type: 'success', sessionId: pendingId
            })
            expect(secondSpawn.mock.calls[0]?.[12]).toBe(pendingId)
        } finally {
            await engine.stop()
        }
    })

    it('returns the durable replacement to a reconnecting clear source without spawning again', async () => {
        const { engine } = (await createEngine())
        try {
            const source = (await createClearSource(engine, { supersededBySessionId: 'already-fresh' }))
            const spawnSession = mock(async () => ({ type: 'success' as const, sessionId: 'must-not-spawn' }))
            setSpawn(engine, spawnSession)

            await expect((engine.clearOpenCodeSession(source.id, 'default'))).resolves.toEqual({
                type: 'success', sessionId: 'already-fresh'
            })
            expect(spawnSession).not.toHaveBeenCalled()
        } finally {
            await engine.stop()
        }
    })

    it('refuses source metadata that points to a machine outside its namespace', async () => {
        const { engine } = (await createEngine())
        try {
            const source = (await engine.getOrCreateSession('cross-namespace-clear', {
                path: '/tmp/project', host: 'host', machineId: 'machine-1', flavor: 'opencode',
                lifecycleState: 'archived', archiveReason: 'Cleared by /clear'
            }, null, 'other'))
            const spawnSession = mock(async () => ({ type: 'success' as const, sessionId: 'must-not-spawn' }))
            setSpawn(engine, spawnSession)

            await expect((engine.clearOpenCodeSession(source.id, 'other'))).resolves.toMatchObject({
                type: 'error', code: 'clear_unavailable'
            })
            expect(spawnSession).not.toHaveBeenCalled()
        } finally {
            await engine.stop()
        }
    })

    it('moves pending scheduled prompts to the replacement before it links the archived source', async () => {
        const { store, engine } = (await createEngine())
        try {
            const source = (await createClearSource(engine))
            const events: Array<{ type: string, sessionId?: string }> = []
            engine.subscribe((event) => events.push(event))
            const scheduled = (await store.messages.addMessage(source.id, { text: 'send later' }, 'scheduled-clear', Date.now() + 60_000))
            const spawnSession = mock(async (...args: unknown[]) => ({ type: 'success' as const, sessionId: args[12] as string }))
            setSpawn(engine, spawnSession)

            const result = await engine.clearOpenCodeSession(source.id, 'default')
            expect(result).toMatchObject({ type: 'success' })
            if (result.type !== 'success') throw new Error('expected successful clear')
            expect((await store.messages.getAllMessages(source.id))).not.toEqual(expect.arrayContaining([
                expect.objectContaining({ id: scheduled.id })
            ]))
            expect((await store.messages.getAllMessages(result.sessionId))).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: scheduled.id, localId: 'scheduled-clear', invokedAt: null })
            ]))
            expect(events).toContainEqual(expect.objectContaining({ type: 'messages-invalidated', sessionId: source.id }))
            expect(events).toContainEqual(expect.objectContaining({ type: 'messages-invalidated', sessionId: result.sessionId }))
        } finally {
            await engine.stop()
        }
    })

    it('moves every held prompt to the replacement without falsely consuming it', async () => {
        const { store, engine } = (await createEngine())
        try {
            const source = (await createClearSource(engine))
            await store.messages.addMessage(source.id, { text: 'rejected immediate' }, 'immediate-after-clear')
            await store.messages.addMessage(source.id, { text: 'scheduled transfer' }, 'scheduled-after-clear', Date.now() + 60_000)
            const events: Array<{ type: string, sessionId?: string, localIds?: string[] }> = []
            engine.subscribe((event) => events.push(event))
            setSpawn(engine, mock(async (...args: unknown[]) => ({ type: 'success' as const, sessionId: args[12] as string })))

            const result = await engine.clearOpenCodeSession(source.id, 'default')
            if (result.type !== 'success') throw new Error('expected successful clear')

            expect((await store.messages.getAllMessages(source.id))).toEqual([])
            expect((await store.messages.getAllMessages(result.sessionId))).toEqual(expect.arrayContaining([
                expect.objectContaining({ localId: 'immediate-after-clear', invokedAt: null }),
                expect.objectContaining({ localId: 'scheduled-after-clear', invokedAt: null })
            ]))
            expect(events).not.toContainEqual(expect.objectContaining({ type: 'messages-consumed' }))
        } finally {
            await engine.stop()
        }
    })

    it('keeps the replacement copy when source and target share a queued localId', async () => {
        const { store, engine } = (await createEngine())
        try {
            const source = (await engine.getOrCreateSession('duplicate-held-source', {
                path: '/tmp/project', host: 'host', machineId: 'machine-1', flavor: 'opencode', startedBy: 'runner'
            }, null, 'default'))
            await engine.handleSessionAlive({ sid: source.id, time: Date.now() })
            const reserved = (await engine.reserveOpenCodeClearSession(source.id, 'default'))
            if (reserved.type !== 'success') throw new Error('reservation failed')
            await store.messages.addMessage(reserved.sessionId, { text: 'authoritative retry' }, 'duplicate-local-id')
            await store.messages.addMessage(source.id, { text: 'stale source copy' }, 'duplicate-local-id')
            await store.messages.addMessage(source.id, { text: 'unique immediate' }, 'unique-immediate')
            await store.messages.addMessage(source.id, { text: 'unique scheduled' }, 'unique-scheduled', Date.now() + 60_000)
            expect((await engine.confirmOpenCodeClearCleanup(source.id, 'default', reserved.sessionId))).toMatchObject({ type: 'success' })
            await engine.handleSessionEnd({ sid: source.id, time: Date.now(), reason: 'cleared' })
            setSpawn(engine, mock(async (...args: unknown[]) => ({ type: 'success' as const, sessionId: args[12] as string })))

            await (engine as unknown as { reconcileOpenCodeClears(): Promise<void> }).reconcileOpenCodeClears()

            expect((await store.messages.getAllMessages(source.id))).toEqual([])
            expect((await store.messages.getAllMessages(reserved.sessionId)).map((message) => ({
                localId: message.localId,
                text: (message.content as { text: string }).text,
                invokedAt: message.invokedAt
            }))).toEqual([
                { localId: 'duplicate-local-id', text: 'authoritative retry', invokedAt: null },
                { localId: 'unique-immediate', text: 'unique immediate', invokedAt: null },
                { localId: 'unique-scheduled', text: 'unique scheduled', invokedAt: null }
            ])
            expect((await engine.getSessionByNamespace(source.id, 'default'))?.metadata?.supersededBySessionId).toBe(reserved.sessionId)
        } finally { await engine.stop() }
    })

    it('refuses before spawning while the source is still active', async () => {
        const { engine } = (await createEngine())
        try {
            const source = (await createClearSource(engine))
            await engine.handleSessionAlive({ sid: source.id, time: Date.now() })
            const spawnSession = mock(async () => ({ type: 'success' as const, sessionId: 'must-not-spawn' }))
            setSpawn(engine, spawnSession)

            await expect((engine.clearOpenCodeSession(source.id, 'default'))).resolves.toMatchObject({
                type: 'error', code: 'clear_unavailable'
            })
            expect(spawnSession).not.toHaveBeenCalled()
        } finally {
            await engine.stop()
        }
    })
})
