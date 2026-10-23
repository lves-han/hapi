import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import { createStorageRoutes } from './storage'

const directories: string[] = []

afterEach(async () => {
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('storage usage endpoints', () => {
    it('identifies PostgreSQL instead of reporting retained source bytes as live storage', async () => {
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => { c.set('namespace', 'default'); await next() })
        app.route('/api', createStorageRoutes('/retained/hapi.db', {
            backend: 'postgres',
            getPostgresStorageUsage: async () => { throw new Error('Legacy endpoint must not query PostgreSQL sizes') },
        }))
        const response = await app.request('/api/storage/sqlite')
        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({ error: 'Hub storage uses PostgreSQL; the SQLite file is a retained migration source' })
    })
    function createApp(dbPath: string, namespace = 'default', store?: Pick<Store, 'backend' | 'getPostgresStorageUsage'>) {
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', namespace)
            await next()
        })
        app.route('/api', createStorageRoutes(dbPath, store))
        return app
    }

    it.each(['/api/storage', '/api/storage/sqlite'])('returns the database and existing sidecar sizes at %s', async (endpoint) => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-storage-'))
        directories.push(directory)
        const dbPath = join(directory, 'hapi.db')
        await Promise.all([
            writeFile(dbPath, Buffer.alloc(10)),
            writeFile(`${dbPath}-wal`, Buffer.alloc(20)),
        ])
        const app = createApp(dbPath)

        const response = await app.request(endpoint)

        expect(response.status).toBe(200)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(await response.json()).toEqual({
            ...(endpoint === '/api/storage' ? { backend: 'sqlite' } : {}),
            path: dbPath,
            databaseBytes: 10,
            walBytes: 20,
            shmBytes: 0,
            totalBytes: 30,
        })
    })

    it.each(['/api/storage', '/api/storage/sqlite'])('rejects non-default namespaces at %s', async (endpoint) => {
        const response = await createApp('/unused/hapi.db', 'tenant', {
            backend: 'postgres',
            getPostgresStorageUsage: async () => { throw new Error('Denied requests must not query PostgreSQL sizes') },
        }).request(endpoint)

        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({ error: 'Storage usage is only available to the hub owner' })
    })

    it('returns PostgreSQL usage through the generic endpoint', async () => {
        const usage = { backend: 'postgres' as const, databaseName: 'hapi', totalBytes: 1234 }
        const response = await createApp('/retained/hapi.db', 'default', {
            backend: 'postgres', getPostgresStorageUsage: async () => usage,
        }).request('/api/storage')
        expect(response.status).toBe(200)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(await response.json()).toEqual(usage)
    })

    it('reports a PostgreSQL size query failure', async () => {
        const response = await createApp('/retained/hapi.db', 'default', {
            backend: 'postgres',
            getPostgresStorageUsage: async () => { throw new Error('Storage query failed') },
        }).request('/api/storage')
        expect(response.status).toBe(500)
        expect(await response.json()).toEqual({ error: 'Storage query failed' })
    })
})
