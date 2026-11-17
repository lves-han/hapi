import { describe, expect, it, spyOn } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'
import { registerSessionHandlers } from '../socket/handlers/cli/sessionHandlers'
import type { CliSocketWithData } from '../socket/socketTypes'
import type { OpenCodeRewindOperation } from '@hapi/protocol/schemas'

async function fixture(searchable = false, dbPath = ':memory:') {
    const store = new Store(dbPath)
    const engine = await SyncEngine.create(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    const session = await engine.getOrCreateSession('opencode-rewind', { path: '/tmp/project', host: 'fixture', flavor: 'opencode',
        opencodeSessionId: 'native', opencodeWorkerId: 'worker', opencodeWorkerProcess: { workerId: 'worker', pid: 4321, startMarker: 'worker-generation' }, conversationHistoryIndexes: { one: 0, two: 1 },
        opencodeHistoryCheckpoint: { sessionId: 'native', messageIds: ['u1', 'a1', 'u2', 'a2'], userMessageIds: ['u1', 'u2'], localMessageIds: [] },
        capabilities: { conversationHistory: { rewindToMessage: true } } }, null, 'default')
    await engine.handleSessionAlive({ sid: session.id, time: Date.now(), mode: 'remote' })
    for (const [role, localId, text] of [
        ['user', 'one', 'retainedprefix user'], ['agent', undefined, 'retainedprefix assistant'],
        ['user', 'two', 'removedsuffix user'], ['agent', undefined, 'removedsuffix assistant']
    ] as const) {
        const content = !searchable ? 'synthetic' : role === 'user'
            ? { type: 'text', text }
            : { type: 'codex', data: { type: 'message', id: text, message: text } }
        await store.messages.addMessage(session.id, { role, content }, localId)
        if (localId) await store.messages.markMessagesInvoked(session.id, [localId], Date.now())
    }
    const version = async () => (await store.sessions.getSession(session.id))!.metadataVersion
    return { store, engine, id: session.id, version }
}

describe('OpenCode durable Hub rewind commit', () => {
    it('snapshots the worker process generation into the reservation and correlates it on reports', async () => {
        const f = await fixture()
        const current = (await f.store.sessions.getSession(f.id))!
        await f.store.sessions.updateSessionMetadata(f.id, { ...current.metadata as object,
            opencodeWorkerProcess: { workerId: 'worker', pid: 4321, startMarker: 'worker-generation' } }, (await f.version()), 'default')
        await (f.engine as any).sessionCache.refreshSession(f.id)
        let operation!: OpenCodeRewindOperation
        try {
            ;(f.engine as any).rpcGateway.rewindConversation = async (_id: string, request: { opencodeRewind: OpenCodeRewindOperation }) => {
                operation = request.opencodeRewind
                return { success: false, outcome: 'unknown', error: 'synthetic transport failure' }
            }
            await f.engine.rewindConversation(f.id, 'default', 'two')
            expect(operation).toMatchObject({ workerId: 'worker', workerPid: 4321, workerStartMarker: 'worker-generation' })
            await expect(f.engine.reportOpenCodeRewind(f.id, 'default', { operation: { ...operation, workerPid: 4322 }, phase: 'rejected' }, (await f.version()))).rejects.toThrow('mismatch')
            expect((await f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase: 'rejected' }, (await f.version()))).phase).toBe('rejected')
        } finally { await f.engine.stop(); await f.store.close() }
    })

    it('does not create a new reservation without an immutable worker process generation', async () => {
        const f = await fixture()
        try {
            const current = (await f.store.sessions.getSession(f.id))!
            await f.store.sessions.updateSessionMetadata(f.id, { ...current.metadata as object,
                opencodeWorkerProcess: undefined }, (await f.version()), 'default')
            await (f.engine as any).sessionCache.refreshSession(f.id)
            expect(await f.engine.rewindConversation(f.id, 'default', 'two')).toMatchObject({ type: 'error' })
            expect(((await f.store.sessions.getSession(f.id))!.metadata as any).opencodeRewind).toBeUndefined()
        } finally { await f.engine.stop(); await f.store.close() }
    })

    it('refuses a new reservation when an older CLI changes only the outer worker ID', async () => {
        const f = await fixture()
        const handlers = new Map<string, (data: unknown, ack: (result: unknown) => void) => unknown>()
        const socket = { on: (name: string, handler: (data: unknown, ack: (result: unknown) => void) => unknown) => handlers.set(name, handler),
            to: () => ({ emit() {} }), conn: { close() {} } }
        registerSessionHandlers(socket as unknown as CliSocketWithData, { store: f.store,
            resolveSessionAccess: async () => ({ ok: true, value: (await f.store.sessions.getSession(f.id))! }), emitAccessError() {} })
        let rpcCount = 0
        ;(f.engine as any).rpcGateway.rewindConversation = async () => { rpcCount++; throw new Error('must not dispatch') }
        try {
            const before = (await f.store.sessions.getSession(f.id))!
            let acknowledgement: any
            await handlers.get('update-metadata')!({ sid: f.id, expectedVersion: before.metadataVersion,
                metadata: { ...before.metadata as object, opencodeWorkerId: 'older-wrapper' } }, result => { acknowledgement = result })
            expect(acknowledgement.result).toBe('success')
            const changed = (await f.store.sessions.getSession(f.id))!.metadata as any
            expect(changed.opencodeWorkerProcess.workerId).toBe('worker')
            await (f.engine as any).sessionCache.refreshSession(f.id)
            expect(await f.engine.rewindConversation(f.id, 'default', 'two')).toMatchObject({ type: 'error' })
            expect(((await f.store.sessions.getSession(f.id))!.metadata as any).opencodeRewind).toBeUndefined()
            expect(rpcCount).toBe(0)
        } finally { await f.engine.stop(); await f.store.close() }
    })

    it.each([{ workerId: 'other', pid: 4321, startMarker: 'worker-generation' },
        { workerId: 'worker', pid: 4321 }, { workerId: 'worker', startMarker: 'worker-generation' }])(
        'refuses an unmatched or incomplete worker process proof', async proof => {
            const f = await fixture(); const current = (await f.store.sessions.getSession(f.id))!
            await f.store.sessions.updateSessionMetadata(f.id, { ...current.metadata as object, opencodeWorkerProcess: proof }, (await f.version()), 'default')
            await (f.engine as any).sessionCache.refreshSession(f.id)
            let rpcCount = 0
            ;(f.engine as any).rpcGateway.rewindConversation = async () => { rpcCount++; throw new Error('must not dispatch') }
            try {
                expect(await f.engine.rewindConversation(f.id, 'default', 'two')).toMatchObject({ type: 'error' })
                expect(((await f.store.sessions.getSession(f.id))!.metadata as any).opencodeRewind).toBeUndefined()
                expect(rpcCount).toBe(0)
            } finally { await f.engine.stop(); await f.store.close() }
        })

    it.each(['prepare-first', 'reject-first'] as const)('serializes preparation and rejection with file SQLite (%s)', async order => {
        const f = await fixture(true, join(mkdtempSync(join(tmpdir(), 'hapi-rewind-cas-')), 'hub.sqlite'))
        let operation!: OpenCodeRewindOperation
        const hashes = { sourceHash: 'a'.repeat(64), prefixHash: 'b'.repeat(64) }
        try {
            ;(f.engine as any).rpcGateway.rewindConversation = async (_id: string, request: { opencodeRewind: OpenCodeRewindOperation }) => {
                operation = request.opencodeRewind
                return { success: false, outcome: 'unknown', error: 'synthetic lost RPC' }
            }
            await f.engine.rewindConversation(f.id, 'default', 'two')
            const reservedVersion = await f.version()
            if (order === 'prepare-first') {
                expect((await f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase: 'prepared', ...hashes }, reservedVersion)).phase).toBe('prepared')
                await expect(f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase: 'rejected' }, reservedVersion)).rejects.toThrow('version changed')
                await expect(f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase: 'rejected' }, (await f.version()))).rejects.toThrow('without recovery evidence')
                expect(((await f.store.sessions.getSession(f.id))!.metadata as any).opencodeRewind.phase).toBe('prepared')
            } else {
                expect((await f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase: 'rejected' }, reservedVersion)).phase).toBe('rejected')
                expect((await f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase: 'prepared', ...hashes }, reservedVersion)).phase).toBe('rejected')
                expect(((await f.store.sessions.getSession(f.id))!.metadata as any).opencodeRewind.phase).toBe('rejected')
            }
            expect((await f.store.messages.getAllMessages(f.id))).toHaveLength(4)
        } finally { await f.engine.stop(); await f.store.close() }
    })

    it('keeps an unprepared unknown report reserved and admission blocked until rejection', async () => {
        const f = await fixture(true)
        let operation!: OpenCodeRewindOperation
        const reports: OpenCodeRewindOperation[] = []
        const before = await f.store.messages.getAllMessages(f.id)
        const epoch = await f.store.messages.getMessageEpoch(f.id)
        try {
            ;(f.engine as any).rpcGateway.rewindConversation = async (_id: string, request: { opencodeRewind: OpenCodeRewindOperation }) => {
                operation = request.opencodeRewind
                reports.push((await f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase:'unknown' }, (await f.version()))))
                reports.push((await f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase:'unknown' }, (await f.version()))))
                return { success:false, outcome:'unknown', error:'prepared report failed before persistence' }
            }
            expect((await f.engine.rewindConversation(f.id, 'default', 'two')).type).toBe('error')
            expect(reports.map(report => report.phase)).toEqual(['reserved', 'reserved'])
            expect(reports.every(report => report.sourceHash === undefined && report.prefixHash === undefined)).toBe(true)
            await expect(f.engine.sendMessage(f.id, { text:'must remain blocked' })).rejects.toThrow('in progress')
            expect((await f.store.messages.getAllMessages(f.id))).toEqual(before)
            expect((await f.store.messages.getMessageEpoch(f.id))).toBe(epoch)
            expect((await f.store.messages.searchContentInSession('removedsuffix', 'default', f.id)).total).toBe(2)
            expect((await f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase:'rejected', unchanged:true,
                sourceHash:'a'.repeat(64), prefixHash:'b'.repeat(64) }, (await f.version()))).phase).toBe('rejected')
        } finally { await f.engine.stop(); await f.store.close() }
    })

    it('keeps prepared unknown proofs and refuses rejection without matching unchanged-source evidence', async () => {
        const f = await fixture(true)
        let operation!: OpenCodeRewindOperation
        const hashes = { sourceHash:'a'.repeat(64), prefixHash:'b'.repeat(64) }
        try {
            ;(f.engine as any).rpcGateway.rewindConversation = async (_id: string, request: { opencodeRewind: OpenCodeRewindOperation }) => {
                operation = request.opencodeRewind
                await f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase:'prepared', ...hashes }, (await f.version()))
                return { success:false, outcome:'unknown', error:'prepared ACK lost' }
            }
            await f.engine.rewindConversation(f.id, 'default', 'two')
            expect((await f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase:'unknown' }, (await f.version()))))
                .toMatchObject({ phase:'unknown', ...hashes })
            const before = { rows:(await f.store.messages.getAllMessages(f.id)), session:(await f.store.sessions.getSession(f.id)),
                epoch:(await f.store.messages.getMessageEpoch(f.id)) }
            for (const report of [{ operation, phase:'rejected' as const },
                { operation, phase:'rejected' as const, unchanged:true as const, sourceHash:'c'.repeat(64), prefixHash:hashes.prefixHash }]) {
                await expect(f.engine.reportOpenCodeRewind(f.id, 'default', report, (await f.version()))).rejects.toThrow('without recovery evidence')
                expect({ rows:(await f.store.messages.getAllMessages(f.id)), session:(await f.store.sessions.getSession(f.id)),
                    epoch:(await f.store.messages.getMessageEpoch(f.id)) }).toEqual(before)
            }
            expect((await f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase:'rejected', unchanged:true, ...hashes }, (await f.version()))).phase)
                .toBe('rejected')
        } finally { await f.engine.stop(); await f.store.close() }
    })

    for (const requestedQueuedBoundary of [false, true]) {
        it(`refuses uninvoked boundaries before reservation (${requestedQueuedBoundary ? 'requested boundary' : 'another future scheduled input'})`, async () => {
            const f = await fixture(true)
            let nativeCalls = 0
            try {
                const queued = await f.store.messages.addMessage(f.id, { role: 'user', content: { type: 'text', text: 'pending scheduled input' } },
                    'pending', Date.now() + 60_000)
                const before = { rows: (await f.store.messages.getAllMessages(f.id)), session: (await f.store.sessions.getSession(f.id)),
                    epoch: (await f.store.messages.getMessageEpoch(f.id)), search: (await f.store.messages.searchContent('removedsuffix', 'default')) }
                ;(f.engine as any).rpcGateway.rewindConversation = async () => { nativeCalls++; throw new Error('must not reach native') }
                expect(await f.engine.rewindConversation(f.id, 'default', requestedQueuedBoundary ? 'pending' : 'two'))
                    .toMatchObject({ type: 'error', message: 'Session has queued messages' })
                expect(nativeCalls).toBe(0)
                expect({ rows: (await f.store.messages.getAllMessages(f.id)), session: (await f.store.sessions.getSession(f.id)),
                    epoch: (await f.store.messages.getMessageEpoch(f.id)), search: (await f.store.messages.searchContent('removedsuffix', 'default')) }).toEqual(before)
                expect((await f.store.messages.getMessageById(f.id, queued.id))?.invokedAt).toBeNull()
                expect(((await f.store.sessions.getSession(f.id))!.metadata as any).opencodeRewind).toBeUndefined()
            } finally { await f.engine.stop(); await f.store.close() }
        })
    }

    for (const phase of ['reserved', 'prepared'] as const) {
        for (const invoked of [false, true]) {
            it(`preserves post-reservation changes instead of truncating (${phase}, ${invoked ? 'newly invoked' : 'uninvoked scheduled'})`, async () => {
                const f = await fixture(true)
                const db = (f.store as unknown as { db: Database }).db
                const invalidations: unknown[] = []
                const unsubscribe = f.engine.subscribe(event => { if (event.type === 'messages-invalidated') invalidations.push(event) })
                const snapshot = async () => ({ rows: (await f.store.messages.getAllMessages(f.id)), session: (await f.store.sessions.getSession(f.id)),
                    epoch: (await f.store.messages.getMessageEpoch(f.id)),
                    read: db.query('SELECT content_revision, read_revision, read_state_version, manual_unread FROM sessions WHERE id = ?').get(f.id),
                    lookup: db.query('SELECT * FROM message_content_search_lookup ORDER BY search_rowid').all(),
                    fts: db.query('SELECT rowid, * FROM message_content_search ORDER BY rowid').all(),
                    short: db.query('SELECT * FROM message_content_search_short ORDER BY gram, search_rowid').all() })
                let checkedRejection = false
                try {
                    ;(f.engine as any).rpcGateway.rewindConversation = async (_id: string, request: { opencodeRewind: OpenCodeRewindOperation }) => {
                        const operation = request.opencodeRewind
                        const hashes = { sourceHash: 'a'.repeat(64), prefixHash: 'b'.repeat(64) }
                        if (phase === 'prepared') await f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase: 'prepared', ...hashes }, (await f.version()))
                        const queued = await f.store.messages.addMessage(f.id, { role: 'user', content: { type: 'text', text: 'post reservation input' } },
                            'new-input', Date.now() + (invoked ? -1 : 60_000))
                        if (invoked) await f.store.messages.markMessagesInvoked(f.id, ['new-input'], Date.now())
                        const before = await snapshot()
                        await expect(f.engine.reportOpenCodeRewind(f.id, 'default', { operation,
                            phase: phase === 'reserved' ? 'prepared' : 'applied', ...hashes,
                            checkpoint: { sessionId: 'native', messageIds: ['u1', 'a1'], userMessageIds: ['u1'], localMessageIds: [] },
                            indexes: { one: 0 } }, (await f.version()))).rejects.toThrow('OpenCode source transcript changed')
                        expect((await snapshot())).toEqual(before)
                        expect(((await f.store.sessions.getSession(f.id))!.metadata as any).opencodeRewind.phase).toBe(phase)
                        expect((await f.store.messages.getMessageById(f.id, queued.id))).not.toBeNull()
                        expect(invalidations).toEqual([])
                        checkedRejection = true
                        return { success: false, outcome: 'unknown', error: 'source changed' }
                    }
                    expect((await f.engine.rewindConversation(f.id, 'default', 'two')).type).toBe('error')
                    expect(checkedRejection).toBe(true)
                    const beforeAdmission = await snapshot()
                    expect((await f.engine.getDeliverableMessagesAfter(f.id, { afterSeq: 0, limit: 100, now: Date.now() + 120_000 }))).toEqual([])
                    await expect(f.engine.sendMessage(f.id, { text: 'blocked input', localId: 'must-not-create' })).rejects.toThrow('in progress')
                    expect((await snapshot())).toEqual(beforeAdmission)
                } finally { unsubscribe(); await f.engine.stop(); await f.store.close() }
            })
        }
    }

    it('preserves the native prefix when an earlier-inserted scheduled boundary is invoked after an ordinary turn', async () => {
        const store = new Store(':memory:')
        const engine = await SyncEngine.create(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        const sourceCheckpoint = { sessionId: 'native', messageIds: ['u1', 'a1', 'u2', 'a2'],
            userMessageIds: ['u1', 'u2'], localMessageIds: [] }
        const checkpoint = { ...sourceCheckpoint, messageIds: ['u1', 'a1'], userMessageIds: ['u1'] }
        const session = await engine.getOrCreateSession('scheduled-rewind', { path: '/tmp/project', host: 'fixture', flavor: 'opencode',
            opencodeSessionId: 'native', opencodeWorkerId: 'worker', opencodeWorkerProcess: { workerId: 'worker', pid: 4321, startMarker: 'worker-generation' }, conversationHistoryIndexes: { one: 0, two: 1 },
            opencodeHistoryCheckpoint: sourceCheckpoint,
            capabilities: { conversationHistory: { rewindToMessage: true } } }, null, 'default')
        await engine.handleSessionAlive({ sid: session.id, time: Date.now(), mode: 'remote' })
        const db = (store as unknown as { db: Database }).db
        const at = Date.now() - 10_000
        const version = async () => (await store.sessions.getSession(session.id))!.metadataVersion
        const hashes = { sourceHash: 'a'.repeat(64), prefixHash: 'b'.repeat(64) }
        const invalidations: unknown[] = []
        let operation!: OpenCodeRewindOperation
        const unsubscribe = engine.subscribe(async event => {
            if (event.type === 'messages-invalidated') invalidations.push({ inTransaction: db.inTransaction,
                phase: ((await store.sessions.getSession(session.id))!.metadata as any).opencodeRewind.phase,
                retained: (await store.messages.searchContentInSession('ordinaryprefix', 'default', session.id)).total,
                removed: (await store.messages.searchContentInSession('scheduledsuffix', 'default', session.id)).total })
        })
        try {
            const scheduled = await store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'scheduledsuffix' } },
                'two', at + 3_000, at)
            const ordinary = await store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'ordinaryprefix' } },
                'one', undefined, at + 1_000)
            await store.messages.markMessagesInvoked(session.id, ['one'], at + 1_000)
            const ordinaryReply = await store.messages.addMessage(session.id,
                { role: 'agent', content: { type: 'codex', data: { type: 'message', id: 'ordinary', message: 'ordinaryprefix' } } },
                undefined, undefined, at + 2_000)
            await store.messages.markMessagesInvoked(session.id, ['two'], at + 3_000)
            const scheduledReply = await store.messages.addMessage(session.id,
                { role: 'agent', content: { type: 'codex', data: { type: 'message', id: 'scheduled', message: 'scheduledsuffix' } } },
                undefined, undefined, at + 4_000)
            expect(scheduled.seq).toBeLessThan(ordinary.seq)
            expect((await store.messages.getMessageById(session.id, scheduled.id))!.invokedAt).toBeGreaterThan(ordinaryReply.invokedAt!)
            const epoch = await store.messages.getMessageEpoch(session.id)
            const lookups = db.query('SELECT * FROM message_content_search_lookup WHERE target_message_id IN (?, ?) ORDER BY search_rowid')
                .all(ordinary.id, ordinaryReply.id)
            ;(engine as any).rpcGateway.rewindConversation = async (_id: string, request: { opencodeRewind: OpenCodeRewindOperation }) => {
                operation = request.opencodeRewind
                await engine.reportOpenCodeRewind(session.id, 'default', { operation, phase: 'prepared', ...hashes }, (await version()))
                await engine.reportOpenCodeRewind(session.id, 'default', { operation, phase: 'applied', ...hashes, checkpoint, indexes: { one: 0 } }, (await version()))
                return { success: true, truncateFromLocalId: 'two' }
            }
            expect(await engine.rewindConversation(session.id, 'default', 'two')).toEqual({ type: 'success' })
            expect(operation.cutoffSeq).toBe(scheduled.seq)
            expect((await store.messages.getAllMessages(session.id)).map(row => row.id)).toEqual([ordinary.id, ordinaryReply.id])
            expect((await store.messages.searchContentInSession('ordinaryprefix', 'default', session.id)).total).toBe(2)
            expect((await store.messages.searchContent('scheduledsuffix', 'default'))).toEqual([])
            expect((await store.messages.searchContentInSession('sc', 'default', session.id)).matches).toEqual([])
            expect(db.query('SELECT * FROM message_content_search_lookup ORDER BY search_rowid').all()).toEqual(lookups)
            for (const row of [scheduled, scheduledReply]) {
                expect((await store.messages.getMessageById(session.id, row.id))).toBeNull()
                expect((await engine.getMessageContext(session.id, row.id))).toBeNull()
            }
            expect((await engine.getMessageContext(session.id, ordinary.id))?.messages.map(row => row.id)).toEqual([ordinary.id, ordinaryReply.id])
            expect((await store.sessions.getSession(session.id))!.metadata).toMatchObject({ opencodeHistoryCheckpoint: checkpoint,
                conversationHistoryIndexes: { one: 0 }, opencodeRewind: { phase: 'committed' } })
            expect((await store.messages.getMessageEpoch(session.id))).toBe(epoch + 1)
            expect(invalidations).toEqual([{ inTransaction: false, phase: 'committed', retained: 2, removed: 0 }])
            const later = await store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'afterrewind' } }, 'later')
            await store.messages.markMessagesInvoked(session.id, ['later'], Date.now())
            const committedVersion = await version()
            expect((await engine.reportOpenCodeRewind(session.id, 'default', { operation, phase: 'applied', ...hashes,
                checkpoint, indexes: { one: 0 } }, 0)).phase).toBe('committed')
            expect((await store.messages.getMessageById(session.id, later.id))).not.toBeNull()
            expect((await store.messages.getMessageEpoch(session.id))).toBe(epoch + 1)
            expect((await version())).toBe(committedVersion)
            expect(invalidations).toHaveLength(1)
        } finally { unsubscribe(); await engine.stop(); await store.close() }
    })

    it('atomically removes only cutoff search rows before invalidation and preserves later rows on committed replay', async () => {
        const f = await fixture(true)
        const rows = await f.store.messages.getAllMessages(f.id)
        const db = (f.store as unknown as { db: Database }).db
        const invalidations: unknown[] = []
        const unsubscribe = f.engine.subscribe(async event => {
            if (event.type === 'messages-invalidated') invalidations.push({
                inTransaction: db.inTransaction,
                phase: ((await f.store.sessions.getSession(f.id))!.metadata as any).opencodeRewind.phase,
                matches: (await f.store.messages.searchContent('removedsuffix', 'default'))
            })
        })
        const checkpoint = { sessionId: 'native', messageIds: ['u1', 'a1'], userMessageIds: ['u1'], localMessageIds: [] }
        const hashes = { sourceHash: 'a'.repeat(64), prefixHash: 'b'.repeat(64) }
        let operation!: OpenCodeRewindOperation
        try {
            const prefixContext = await f.engine.getMessageContext(f.id, rows[0]!.id)
            expect(prefixContext).not.toBeNull()
            expect((await f.store.messages.searchContentInSession('removedsuffix', 'default', f.id)).total).toBe(2)
            expect((await f.store.messages.searchContentInSession('re', 'default', f.id)).total).toBe(4)
            const prefixLookups = db.query('SELECT * FROM message_content_search_lookup WHERE target_message_id IN (?, ?) ORDER BY search_rowid')
                .all(rows[0]!.id, rows[1]!.id)
            const beforeRevision = (await f.store.sessions.getSession(f.id))!.contentRevision
            db.query(`UPDATE sessions SET manual_unread = 1, read_revision = (
                SELECT MAX(content_revision) FROM messages WHERE session_id = ? AND seq < 3
            ) WHERE id = ?`).run(f.id, f.id)
            const beforeRead = db.query('SELECT read_revision, content_revision, read_state_version FROM sessions WHERE id = ?')
                .get(f.id) as { read_revision: number; content_revision: number; read_state_version: number }
            expect(beforeRead.read_revision).toBeLessThan(beforeRead.content_revision)
            ;(f.engine as any).rpcGateway.rewindConversation = async (_id: string, request: { opencodeRewind: OpenCodeRewindOperation }) => {
                operation = request.opencodeRewind
                await f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase: 'prepared', ...hashes }, (await f.version()))
                await f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase: 'applied', ...hashes, checkpoint, indexes: { one: 0 } }, (await f.version()))
                return { success: true, truncateFromLocalId: 'two' }
            }
            expect(await f.engine.rewindConversation(f.id, 'default', 'two')).toEqual({ type: 'success' })
            expect((await f.store.messages.getAllMessages(f.id)).map(row => row.id)).toEqual(rows.slice(0, 2).map(row => row.id))
            expect((await f.store.messages.searchContent('removedsuffix', 'default'))).toEqual([])
            expect((await f.store.messages.searchContentInSession('removedsuffix', 'default', f.id))).toMatchObject({ total: 0, matches: [] })
            expect((await f.store.messages.searchContentInSession('re', 'default', f.id)).matches.map(match => match.messageId).sort())
                .toEqual(rows.slice(0, 2).map(row => row.id).sort())
            expect((await f.store.messages.searchContent('retainedprefix', 'default'))).toHaveLength(1)
            expect((await f.store.messages.searchContentInSession('retainedprefix', 'default', f.id)).total).toBe(2)
            for (const row of rows.slice(2)) {
                expect((await f.store.messages.getMessageById(f.id, row.id))).toBeNull()
                expect((await f.engine.getMessageContext(f.id, row.id))).toBeNull()
                expect(db.query('SELECT * FROM message_content_search_lookup WHERE target_message_id = ? OR message_id = ?').all(row.id, row.id)).toEqual([])
            }
            expect(db.query('SELECT * FROM message_content_search_lookup ORDER BY search_rowid').all()).toEqual(prefixLookups)
            expect(db.query('SELECT * FROM message_content_search_short WHERE search_rowid NOT IN (SELECT search_rowid FROM message_content_search_lookup)').all()).toEqual([])
            expect(db.query('SELECT rowid FROM message_content_search WHERE rowid NOT IN (SELECT search_rowid FROM message_content_search_lookup)').all()).toEqual([])
            expect((await f.engine.getMessageContext(f.id, rows[0]!.id))?.messages.map(row => row.id)).toEqual(rows.slice(0, 2).map(row => row.id))
            expect((await f.store.messages.getMessageEpoch(f.id))).toBe(1)
            expect((await f.store.sessions.getSession(f.id))!.contentRevision).toBe(beforeRevision)
            expect(db.query('SELECT read_revision, content_revision, read_state_version, manual_unread FROM sessions WHERE id = ?').get(f.id))
                .toEqual({ read_revision: beforeRead.content_revision, content_revision: beforeRead.content_revision,
                    read_state_version: beforeRead.read_state_version + 1, manual_unread: 1 })
            expect(invalidations).toEqual([{ inTransaction: false, phase: 'committed', matches: [] }])

            const later = await f.store.messages.addMessage(f.id, { role: 'user', content: { type: 'text', text: 'latersearch' } }, 'later')
            await f.store.messages.markMessagesInvoked(f.id, ['later'], Date.now())
            expect(later.seq).toBe(operation.cutoffSeq)
            const beforeReplay = await f.store.messages.searchContentInSession('latersearch', 'default', f.id)
            const metadataVersion = await f.version()
            const result = await f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase: 'applied', ...hashes, checkpoint, indexes: { one: 0 } }, 0)
            expect(result.phase).toBe('committed')
            expect((await f.store.messages.getMessageById(f.id, later.id))).not.toBeNull()
            expect((await f.store.messages.searchContentInSession('latersearch', 'default', f.id))).toEqual(beforeReplay)
            expect(beforeReplay.matches[0]?.messageId).toBe(later.id)
            expect((await f.engine.getMessageContext(f.id, later.id))?.targetMessageId).toBe(later.id)
            expect((await f.store.messages.getMessageEpoch(f.id))).toBe(1)
            expect((await f.version())).toBe(metadataVersion)
            expect(invalidations).toHaveLength(1)
        } finally { unsubscribe(); await f.engine.stop(); await f.store.close() }
    })

    for (const failureAt of ['metadata CAS', 'search cleanup'] as const) {
        it(`rolls back transcript, every search table and read state when ${failureAt} fails`, async () => {
            const f = await fixture(true)
            const db = (f.store as unknown as { db: Database }).db
            const invalidations: unknown[] = []
            let checkedRollback = false
            const unsubscribe = f.engine.subscribe(event => { if (event.type === 'messages-invalidated') invalidations.push(event) })
            const snapshot = async () => ({
                rows: (await f.store.messages.getAllMessages(f.id)),
                epoch: (await f.store.messages.getMessageEpoch(f.id)),
                readState: db.query('SELECT content_revision, read_revision, read_state_version, manual_unread FROM sessions WHERE id = ?').get(f.id),
                fts: db.query('SELECT rowid, * FROM message_content_search ORDER BY rowid').all(),
                lookup: db.query('SELECT * FROM message_content_search_lookup ORDER BY search_rowid').all(),
                short: db.query('SELECT * FROM message_content_search_short ORDER BY gram, search_rowid').all(),
                global: (await f.store.messages.searchContent('removedsuffix', 'default')),
                inSession: (await f.store.messages.searchContentInSession('removedsuffix', 'default', f.id)),
                shortSearch: (await f.store.messages.searchContentInSession('re', 'default', f.id))
            })
            try {
                ;(f.engine as any).rpcGateway.rewindConversation = async (_id: string, request: { opencodeRewind: OpenCodeRewindOperation }) => {
                    const operation = request.opencodeRewind
                    const hashes = { sourceHash: 'a'.repeat(64), prefixHash: 'b'.repeat(64) }
                    await f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase: 'prepared', ...hashes }, (await f.version()))
                    const before = await snapshot()
                    const failure = failureAt === 'metadata CAS'
                        ? spyOn(f.store.sessions, 'updateSessionMetadata').mockResolvedValue({ result: 'error' }) : null
                    if (failureAt === 'search cleanup') db.exec(`
                        CREATE TRIGGER fail_rewind_search_cleanup BEFORE DELETE ON message_content_search_lookup
                        BEGIN SELECT RAISE(ABORT, 'forced search cleanup failure'); END;
                    `)
                    try {
                        await expect(f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase: 'applied', ...hashes,
                            checkpoint: { sessionId: 'native', messageIds: ['u1', 'a1'], userMessageIds: ['u1'], localMessageIds: [] },
                            indexes: { one: 0 } }, (await f.version()))).rejects.toThrow(failureAt === 'metadata CAS' ? 'CAS failed' : 'forced search cleanup failure')
                    } finally { failure?.mockRestore() }
                    expect((await snapshot())).toEqual(before)
                    expect(((await f.store.sessions.getSession(f.id))!.metadata as any).opencodeRewind.phase).toBe('prepared')
                    expect(invalidations).toEqual([])
                    checkedRollback = true
                    return { success: false, outcome: 'unknown', error: failureAt }
                }
                expect((await f.engine.rewindConversation(f.id, 'default', 'two')).type).toBe('error')
                expect(checkedRollback).toBe(true)
                expect((await f.store.messages.getAllMessages(f.id))).toHaveLength(4)
                expect((await f.store.messages.searchContentInSession('removedsuffix', 'default', f.id)).total).toBe(2)
            } finally { unsubscribe(); await f.engine.stop(); await f.store.close() }
        })
    }

    for (const rollback of [false, true]) {
        it(`invalidates injected-turn cache for the exact cutoff${rollback ? ' and lazily restores it after rollback' : ''}`, async () => {
            const store = new Store(':memory:')
            const session = await store.sessions.getOrCreateSession('rewind-cache', { path: '/tmp/project' }, null, 'default')
            const db = (store as unknown as { db: Database }).db
            const injected = (uuid: string) => ({ role: 'agent', content: { type: 'output', data: {
                type: 'user', uuid, message: { content: '<system-reminder>injected</system-reminder>' }
            } } })
            const sentinel = (parentUuid: string) => ({ role: 'agent', content: { type: 'output', data: {
                type: 'assistant', parentUuid, message: { content: [{ type: 'text', text: 'No response requested.' }] }
            } } })
            try {
                await store.messages.addMessage(session.id, injected('retained-injected'))
                await store.messages.addMessage(session.id, sentinel('retained-injected'))
                const cutoff = await store.messages.addMessage(session.id, injected('removed-injected'))
                await store.messages.addMessage(session.id, sentinel('removed-injected'))
                expect((await store.messages.searchContent('No response requested', 'default'))).toEqual([])
                if (rollback) {
                    expect(() => store.runInTransaction(async () => {
                        await store.messages.truncateOpenCodeRewind(session.id, cutoff.seq, cutoff.id)
                        throw new Error('rollback cache cleanup')
                    })).toThrow('rollback cache cleanup')
                    expect((await store.messages.getAllMessages(session.id))).toHaveLength(4)
                    expect((await store.messages.getMessageEpoch(session.id))).toBe(0)
                } else await store.messages.truncateOpenCodeRewind(session.id, cutoff.seq, cutoff.id)
                await store.messages.addMessage(session.id, sentinel('retained-injected'))
                const removedParentReply = await store.messages.addMessage(session.id, sentinel('removed-injected'))
                const matches = await store.messages.searchContentInSession('No response requested', 'default', session.id)
                expect(matches.matches.map(match => match.messageId)).toEqual(rollback ? [] : [removedParentReply.id])
                expect(matches.total).toBe(rollback ? 0 : 1)
                expect(db.inTransaction).toBe(false)
            } finally { await store.close() }
        })
    }

    it('reserves before RPC and atomically commits exact cutoff, metadata and epoch; replay cannot delete a new turn', async () => {
        const f = await fixture(); let operation!: OpenCodeRewindOperation
        const checkpoint = { sessionId: 'native', messageIds: ['u1', 'a1'], userMessageIds: ['u1'], localMessageIds: [] }
        const hashes = { sourceHash: 'a'.repeat(64), prefixHash: 'b'.repeat(64) }
        try {
            ;(f.engine as any).rpcGateway.rewindConversation = async (_id: string, request: { opencodeRewind: OpenCodeRewindOperation }) => {
                operation = request.opencodeRewind
                expect(((await f.store.sessions.getSession(f.id))!.metadata as any).opencodeRewind.operationId).toBe(operation.operationId)
                await f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase: 'prepared', ...hashes }, (await f.version()))
                await f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase: 'applied', ...hashes, checkpoint, indexes: { one: 0 } }, (await f.version()))
                return { success: true, truncateFromLocalId: 'two' }
            }
            expect(await f.engine.rewindConversation(f.id, 'default', 'two')).toEqual({ type: 'success' })
            expect((await f.store.messages.getAllMessages(f.id))).toHaveLength(2)
            const epoch = await f.store.messages.getMessageEpoch(f.id)
            expect(epoch).toBe(1)
            await f.store.messages.addMessage(f.id, { role: 'user', content: 'new turn' }, 'later')
            const replay = await f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase: 'applied', ...hashes, checkpoint, indexes: { one: 0 } }, 0)
            expect(replay.phase).toBe('committed')
            expect((await f.store.messages.getAllMessages(f.id)).at(-1)?.localId).toBe('later')
            expect((await f.store.messages.getMessageEpoch(f.id))).toBe(epoch)
        } finally { await f.engine.stop() }
    })

    it('preserves both histories on output/epoch change instead of applying a stale cutoff', async () => {
        const f = await fixture()
        try {
            ;(f.engine as any).rpcGateway.rewindConversation = async (_id: string, request: { opencodeRewind: OpenCodeRewindOperation }) => {
                const operation = request.opencodeRewind
                const hashes = { sourceHash: 'a'.repeat(64), prefixHash: 'b'.repeat(64) }
                await f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase: 'prepared', ...hashes }, (await f.version()))
                await f.store.messages.addMessage(f.id, { role: 'agent', content: 'late peer output' })
                await expect(f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase: 'applied', ...hashes,
                    checkpoint: { sessionId: 'native', messageIds: ['u1', 'a1'], userMessageIds: ['u1'], localMessageIds: [] }, indexes: { one: 0 } }, (await f.version()))).rejects.toThrow()
                return { success: false, outcome: 'unknown', error: 'conflict' }
            }
            expect((await f.engine.rewindConversation(f.id, 'default', 'two')).type).toBe('error')
            expect((await f.store.messages.getAllMessages(f.id))).toHaveLength(5)
            expect((await f.store.messages.getMessageEpoch(f.id))).toBe(0)
            await expect(f.engine.sendMessage(f.id, { text: 'do not admit', localId: 'blocked' })).rejects.toThrow()
        } finally { await f.engine.stop() }
    })

    it('retains durable admission locks after Hub reconstruction, independent of the volatile history set', async () => {
        const f = await fixture(); let restarted: SyncEngine | undefined
        try {
            ;(f.engine as any).rpcGateway.rewindConversation = async (_id: string, request: { opencodeRewind: OpenCodeRewindOperation }) => {
                await f.engine.reportOpenCodeRewind(f.id, 'default', { operation: request.opencodeRewind, phase: 'unknown' }, (await f.version()))
                throw new Error('CLI disconnected')
            }
            expect((await f.engine.rewindConversation(f.id, 'default', 'two')).type).toBe('error')
            await f.engine.stop()
            restarted = await SyncEngine.create(f.store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
            expect((await restarted.getDeliverableMessagesAfter(f.id, { afterSeq: 0, limit: 100, now: Date.now() }))).toEqual([])
            await expect(restarted.sendMessage(f.id, { text: 'blocked' })).rejects.toThrow('in progress')
            await expect(restarted.applySessionConfig(f.id, { model: 'blocked-model' })).rejects.toThrow('reconciliation')
            await expect(restarted.switchSession(f.id, 'local')).rejects.toThrow('reconciliation')
            expect((await f.store.messages.getAllMessages(f.id))).toHaveLength(4)
        } finally { await restarted?.stop(); await f.engine.stop() }
    })

    it('rolls back deletion/epoch when metadata CAS fails and emits no premature invalidation', async () => {
        const f = await fixture(); const invalidations: unknown[] = []
        const unsubscribe = f.engine.subscribe(event => { if (event.type === 'messages-invalidated') invalidations.push(event) })
        try {
            ;(f.engine as any).rpcGateway.rewindConversation = async (_id: string, request: { opencodeRewind: OpenCodeRewindOperation }) => {
                const operation = request.opencodeRewind; const hashes = { sourceHash: 'a'.repeat(64), prefixHash: 'b'.repeat(64) }
                await f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase: 'prepared', ...hashes }, (await f.version()))
                const failure = spyOn(f.store.sessions, 'updateSessionMetadata').mockResolvedValue({ result: 'error' })
                try {
                    await expect(f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase: 'applied', ...hashes,
                        checkpoint: { sessionId: 'native', messageIds: ['u1', 'a1'], userMessageIds: ['u1'], localMessageIds: [] }, indexes: { one: 0 } }, (await f.version()))).rejects.toThrow('CAS failed')
                } finally { failure.mockRestore() }
                return { success: false, outcome: 'unknown', error: 'CAS failed' }
            }
            await f.engine.rewindConversation(f.id, 'default', 'two')
            expect((await f.store.messages.getAllMessages(f.id))).toHaveLength(4)
            expect((await f.store.messages.getMessageEpoch(f.id))).toBe(0)
            expect(invalidations).toHaveLength(0)
        } finally { unsubscribe(); await f.engine.stop() }
    })

    it('rejects namespace, operation identity and current-version mismatches before native completion', async () => {
        const f = await fixture()
        try {
            ;(f.engine as any).rpcGateway.rewindConversation = async (_id: string, request: { opencodeRewind: OpenCodeRewindOperation }) => {
                const operation = request.opencodeRewind; const hashes = { sourceHash: 'a'.repeat(64), prefixHash: 'b'.repeat(64) }
                await expect(f.engine.reportOpenCodeRewind(f.id, 'other-namespace', { operation, phase: 'prepared', ...hashes }, (await f.version()))).rejects.toThrow('access denied')
                await expect(f.engine.reportOpenCodeRewind(f.id, 'default', { operation: { ...operation, cutoffSeq: 1 }, phase: 'prepared', ...hashes }, (await f.version()))).rejects.toThrow('mismatch')
                await expect(f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase: 'prepared', ...hashes }, (await f.version()) - 1)).rejects.toThrow('version changed')
                return { success: false, outcome: 'unknown', error: 'pending' }
            }
            await f.engine.rewindConversation(f.id, 'default', 'two')
            expect((await f.store.messages.getAllMessages(f.id))).toHaveLength(4)
        } finally { await f.engine.stop() }
    })
})
