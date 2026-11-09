import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { machineSpawnPreallocTag } from '../store/sessions'
import { SessionCache } from './sessionCache'
import type { EventPublisher } from './eventPublisher'

function setup() {
    const store = new Store(':memory:')
    const cache = new SessionCache(store, { emit() {} } as unknown as EventPublisher)
    const create = async (tag: string) => (await cache.getOrCreateSession(tag, {
        path: '/project', host: 'localhost', name: 'Original',
        summary: { text: 'Original summary', updatedAt: 1 }
    }, null, 'default'))
    const write = async (id: string, metadata: unknown) => {
        const current = (await store.sessions.getSession(id))!
        return store.sessions.updateSessionMetadata(id, metadata, current.metadataVersion, 'default')
    }
    return { store, cache, create, write }
}

describe('explicit per-session title lock', () => {
    it('preserves summary-only titles through lock-only saves and native updates after unlock', async () => {
        const { store, cache, write } = setup()
        try {
            const session = (await cache.getOrCreateSession('summary-only', {
                path: '/project', host: 'localhost', summary: { text: 'Native title', updatedAt: 1 }
            }, null, 'default'))
            await cache.renameSession(session.id, undefined, true)
            await write(session.id, { summary: { text: 'Blocked native title', updatedAt: 2 } })
            expect((await store.sessions.getSession(session.id))?.metadata).toMatchObject({ titleLocked: true, summary: { text: 'Native title' } })
            await cache.refreshSession(session.id)
            await cache.renameSession(session.id, undefined, false)
            await write(session.id, { summary: { text: 'New native title', updatedAt: 3 } })
            expect((await store.sessions.getSession(session.id))?.metadata).toMatchObject({ summary: { text: 'New native title' } })
            expect((await store.sessions.getSession(session.id))?.metadata).not.toHaveProperty('name')
        } finally { await store.close() }
    })

    it('allows agent renames after a manual rename unless explicitly locked', async () => {
        const { store, cache, create, write } = setup()
        try {
            const session = (await create('unlocked'))
            await cache.renameSession(session.id, 'User title')
            await write(session.id, { name: 'Agent title' })
            expect((await store.sessions.getSession(session.id))?.metadata).toMatchObject({ name: 'Agent title' })
        } finally { await store.close() }
    })

    it('protects both title fields against sparse, null, forged, and stale agent snapshots', async () => {
        const { store, cache, create, write } = setup()
        try {
            const session = (await create('locked'))
            await cache.renameSession(session.id, 'User title', true)
            for (const metadata of [
                { name: 'Agent', titleLocked: false, summary: { text: 'New', updatedAt: 2 } },
                { titleLocked: null }, null, { lifecycleState: 'running' }
            ]) {
                expect((await write(session.id, metadata)).result).toBe('success')
                expect((await store.sessions.getSession(session.id))?.metadata).toMatchObject({
                    name: 'User title', titleLocked: true, summary: { text: 'Original summary' }
                })
            }
            await cache.refreshSession(session.id)
            await cache.clearSessionArchiveMetadata(session.id)
            expect((await store.sessions.getSession(session.id))?.metadata).toMatchObject({ titleLocked: true, name: 'User title' })
        } finally { await store.close() }
    })

    it('keeps sessions independent, permits user edits, and unlocks only on explicit user save', async () => {
        const { store, cache, create, write } = setup()
        try {
            const first = (await create('first')), second = (await create('second'))
            await cache.renameSession(first.id, 'Pinned', true)
            await write(second.id, { name: 'Other agent title', titleLocked: true })
            expect((await store.sessions.getSession(second.id))?.metadata).not.toHaveProperty('titleLocked', true)
            await cache.refreshSession(first.id)
            await cache.renameSession(first.id, 'User edit')
            await write(first.id, { name: 'Blocked' })
            expect((await store.sessions.getSession(first.id))?.metadata).toMatchObject({ name: 'User edit', titleLocked: true })
            await cache.refreshSession(first.id)
            await cache.renameSession(first.id, 'User edit', false)
            await write(first.id, { name: 'Agent after unlock' })
            expect((await store.sessions.getSession(first.id))?.metadata).toMatchObject({ name: 'Agent after unlock' })
        } finally { await store.close() }
    })

    it('lets a user save a generated title and lock atomically', async () => {
        const { store, cache, create, write } = setup()
        try {
            const session = (await create('generated'))
            await cache.updateSessionSummary(session.id, 'User generated', true)
            await write(session.id, { name: 'Agent', summary: { text: 'Agent summary' } })
            expect((await store.sessions.getSession(session.id))?.metadata).toMatchObject({
                titleLocked: true, name: 'Original', summary: { text: 'User generated' }
            })
        } finally { await store.close() }
    })
})

it('persists a lock through a real database close and reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hapi-title-lock-'))
    try {
        // Separate processes guarantee an actual restart and release SQLite
        // prepared-statement handles before cleanup on Windows.
        const dbPath = join(directory, 'hapi.db')
        const imports = `import { Store } from './hub/src/store'; import { SessionCache } from './hub/src/sync/sessionCache';`
        const create = Bun.spawnSync([process.execPath, '-e', imports + `
            const store = new Store(process.argv[1]);
            const cache = new SessionCache(store, { emit() {} });
            const session = await cache.getOrCreateSession('persist', { path: '/project', host: 'localhost' }, null, 'default');
            await cache.renameSession(session.id, 'Pinned', true); await store.close();
        `, dbPath], { cwd: join(import.meta.dir, '../../..') })
        expect(create.exitCode).toBe(0)
        const reopen = Bun.spawnSync([process.execPath, '-e', imports + `
            const store = new Store(process.argv[1]); const current = (await store.sessions.getSessions())[0];
            await store.sessions.updateSessionMetadata(current.id, { name: 'After restart' }, current.metadataVersion, 'default');
            console.log(JSON.stringify((await store.sessions.getSession(current.id)).metadata)); await store.close();
        `, dbPath], { cwd: join(import.meta.dir, '../../..') })
        expect(reopen.exitCode).toBe(0)
        expect(JSON.parse(reopen.stdout.toString())).toMatchObject({ titleLocked: true, name: 'Pinned' })
    } finally { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }
})

it('preserves a preallocated lock at adoption and rejects forged bootstrap locks', async () => {
    const { store, cache } = setup()
    try {
        const stub = (await store.sessions.getOrCreateSession(machineSpawnPreallocTag('stub-lock'), {
            path: '/project', host: 'localhost', titleLocked: true
        }, null, 'default', undefined, undefined, undefined, 'stub-lock'))
        expect(stub.metadata).not.toHaveProperty('titleLocked', true)
        await cache.renameSession(stub.id, 'Pinned before bootstrap', true)
        const adopted = (await store.sessions.adoptPreallocatedSession(stub.id, 'real-agent', {
            path: '/new', host: 'localhost', name: 'Agent', titleLocked: false
        }, null, 'default'))
        expect(adopted.metadata).toMatchObject({ titleLocked: true, name: 'Pinned before bootstrap' })
    } finally { await store.close() }
})

it('retains the destination lock, transfers a resumed lock, and keeps history imports independent', async () => {
    const { store, cache, create, write } = setup()
    try {
        const source = (await create('source')), destination = (await create('destination'))
        await cache.renameSession(source.id, 'Source pinned', true)
        await cache.mergeSessions(source.id, destination.id, 'default')
        await write(destination.id, { name: 'After resume' })
        expect((await store.sessions.getSession(destination.id))?.metadata).toMatchObject({ titleLocked: true, name: 'Source pinned' })
        const other = (await create('other'))
        await cache.renameSession(other.id, 'Destination pinned', true)
        await cache.mergeSessions(destination.id, other.id, 'default')
        expect((await store.sessions.getSession(other.id))?.metadata).toMatchObject({ titleLocked: true, name: 'Destination pinned' })
        const independent = (await create('independent'))
        await cache.mergeSessionHistory(other.id, independent.id, 'default')
        expect((await store.sessions.getSession(independent.id))?.metadata).not.toHaveProperty('titleLocked', true)
    } finally { await store.close() }
})

it('does not move history when title transfer fails', async () => {
    const { store, cache, create } = setup()
    try {
        const source = (await create('failed-source')), destination = (await create('failed-destination'))
        await cache.renameSession(source.id, 'Pinned', true)
        await store.messages.addMessage(source.id, { text: 'Keep history' })
        const update = store.sessions.updateSessionMetadata.bind(store.sessions)
        store.sessions.updateSessionMetadata = async (...args) => args[4]?.inheritTitleLockFrom ? { result: 'error' } : (await update(...args))
        await expect(cache.mergeSessions(source.id, destination.id, 'default')).rejects.toThrow('preserve session metadata')
        expect((await store.messages.getAllMessages(source.id))).toHaveLength(1)
        expect((await store.messages.getAllMessages(destination.id))).toHaveLength(0)
        expect((await store.sessions.getSession(source.id))?.metadata).toMatchObject({ titleLocked: true })
    } finally { await store.close() }
})
