// Uses an isolated generated database. HAPI_TEST_DATABASE_URL must allow CREATE DATABASE.
import assert from 'node:assert/strict'
import { SQL } from 'bun'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, arch, cpus } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store } from '../src/store'
import { openStore } from '../src/store/openStore'
import { startHub, type HubInstance } from '../src/startHub'

if (!process.env.HAPI_TEST_DATABASE_URL) throw new Error('Set HAPI_TEST_DATABASE_URL to an isolated test PostgreSQL server')
const admin = new SQL(process.env.HAPI_TEST_DATABASE_URL, { max: 1 })
const name = `hapi_perf_${randomUUID().replaceAll('-', '')}`
const url = new URL(process.env.HAPI_TEST_DATABASE_URL)
url.pathname = '/' + name
const dir = mkdtempSync(join(tmpdir(), 'hapi-pg-perf-'))
const dbPath = join(dir, 'hapi.db')
const ids = Array.from({ length: 177 }, (_, i) => `perf-session-${i}`)
const historyCount = 510_420
const sampleCount = 50
const now = Date.now()
const output = console.log
console.log = (...args) => console.error(...args)
let hub: HubInstance | undefined
let store: Store | undefined
let sql: SQL | undefined
let timer: ReturnType<typeof setInterval> | undefined
const lagMs: number[] = []

function distribution(samples: number[]) {
    const sorted = [...samples].sort((a, b) => a - b)
    return { p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], maxMs: sorted.at(-1), samples }
}
async function measure(run: () => Promise<unknown>) {
    for (let i = 0; i < 3; i++) await run()
    const samples = []
    for (let i = 0; i < sampleCount; i++) {
        const start = performance.now()
        await run()
        samples.push(performance.now() - start)
    }
    return distribution(samples)
}

try {
    await admin.unsafe(`CREATE DATABASE ${name}`)
    const source = new Store(dbPath)
    const db = source.sqliteDatabase
    db.transaction(() => {
        const insert = db.prepare(`INSERT INTO sessions (id, namespace, created_at, updated_at, metadata) VALUES (?, 'default', 0, 0, '{"path":"/benchmark","host":"test","flavor":"codex"}')`)
        for (const id of ids) insert.run(id)
        db.exec(`WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM rows WHERE n < ${historyCount})
            INSERT INTO messages (id, session_id, content, created_at, seq, local_id, invoked_at)
            SELECT 'history-' || n, 'perf-session-' || (n % 177), '{"role":"user","content":{"type":"text","text":"history"}}', 0, n, 'local-' || n, 0 FROM rows`)
    })()
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    await source.close()
    const importStart = performance.now()
    store = await openStore({ dataDir: dir, dbPath, databaseUrl: url.href })
    const importMs = performance.now() - importStart
    sql = new SQL(url.href, { max: 2 })
    const [version] = await sql`SELECT version() AS version`
    const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
    const port = reservation.port
    await reservation.stop()
    Object.assign(process.env, { HAPI_HOME: dir, DATABASE_URL: url.href, HAPI_LISTEN_HOST: '127.0.0.1', HAPI_LISTEN_PORT: String(port), HAPI_PUBLIC_URL: `http://127.0.0.1:${port}`, CLI_API_TOKEN: 'benchmark-local-only', HAPI_IOS_PUSH: 'off', HAPI_ANDROID_PUSH: 'off', TELEGRAM_BOT_TOKEN: '', SERVERCHAN_SENDKEY: '', SERVERCHAN_NOTIFICATION: 'false' })
    delete process.env.DB_PATH
    hub = await startHub({ args: ['--no-relay'] })
    const base = `http://127.0.0.1:${port}`
    const auth = await fetch(`${base}/api/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: 'benchmark-local-only' }) })
    assert.equal(auth.status, 200)
    const { token } = await auth.json() as { token: string }
    const headers = { Authorization: `Bearer ${token}` }
    let previous = performance.now()
    timer = setInterval(() => {
        const current = performance.now()
        lagMs.push(Math.max(0, current - previous - 20))
        previous = current
    }, 20)
    const idleCpu = process.cpuUsage()
    const idleStart = performance.now()
    const rssBefore = process.memoryUsage.rss()
    await Bun.sleep(5_000)
    const cpu = process.cpuUsage(idleCpu)
    const passive = { intervalMs: performance.now() - idleStart, cpuMs: (cpu.user + cpu.system) / 1_000, rssBefore, rssAfter: process.memoryUsage.rss() }
    const cases = []
    for (const pending of [0, 1, 1_000]) {
        await sql`DELETE FROM messages WHERE scheduled_at IS NOT NULL`
        if (pending) await sql.unsafe(`INSERT INTO messages (id, session_id, content, created_at, seq, local_id, scheduled_at)
            SELECT 'scheduled-' || n, 'perf-session-' || ((n - 1) % 177), convert_to('{}', 'UTF8'), 0, ${historyCount} + n, 'scheduled-' || n, $1 + n
            FROM generate_series(1, $2::integer) AS n`, [now + 86_400_000, pending])
        await sql`ANALYZE messages`
        const expectedCount = new Map<string, number>()
        const expectedMin = new Map<string, number>()
        for (let i = 0; i < pending; i++) {
            const id = ids[i % ids.length]
            expectedCount.set(id, (expectedCount.get(id) ?? 0) + 1)
            expectedMin.set(id, expectedMin.get(id) ?? now + 86_400_000 + i + 1)
        }
        const count = await measure(async () => assert.deepEqual(await store!.messages.countFutureScheduledBySessionIds(ids, now), expectedCount))
        const min = await measure(async () => assert.deepEqual(await store!.messages.minFutureScheduledAtBySessionIds(ids, now), expectedMin))
        const plans = []
        for (const aggregate of ['COUNT(*)', 'MIN(scheduled_at)']) {
            plans.push(await sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT session_id, ${aggregate} FROM messages
                WHERE session_id IN (${ids.map((_, i) => `$${i + 1}`).join(',')}) AND invoked_at IS NULL AND local_id IS NOT NULL
                AND scheduled_at IS NOT NULL AND scheduled_at > $${ids.length + 1} AND delivery_state = 'queued' GROUP BY session_id`, [...ids, now]))
        }
        const requests: { sessionMs: number; healthMs: number; sessionStatus: number; healthStatus: number; bytes: number }[] = []
        for (let i = 0; i < sampleCount; i++) {
            const start = performance.now()
            const response = await fetch(`${base}/api/sessions`, { headers })
            const body = await response.text()
            const sessionMs = performance.now() - start
            assert.equal(response.status, 200)
            const sessions = JSON.parse(body).sessions as { id: string; futureScheduledMessageCount: number; nextScheduledAt: number | null }[]
            assert.equal(sessions.length, ids.length)
            for (const session of sessions) {
                assert.equal(session.futureScheduledMessageCount, expectedCount.get(session.id) ?? 0)
                assert.equal(session.nextScheduledAt, expectedMin.get(session.id) ?? null)
            }
            const healthStart = performance.now()
            const health = await fetch(`${base}/health`)
            await health.arrayBuffer()
            assert.equal(health.status, 200)
            requests.push({ sessionMs, healthMs: performance.now() - healthStart, sessionStatus: response.status, healthStatus: health.status, bytes: Buffer.byteLength(body) })
        }
        cases.push({ pending, count, min, plans, sessions: distribution(requests.map(row => row.sessionMs)), health: distribution(requests.map(row => row.healthMs)), requests })
    }
    clearInterval(timer)
    const [databaseStats] = await sql`SELECT numbackends, xact_commit, xact_rollback, blks_read, blks_hit, tup_inserted FROM pg_stat_database WHERE datname = current_database()`
    output(JSON.stringify({ recordedAt: new Date().toISOString(), environment: { bun: Bun.version, postgres: version.version, arch: arch(), logicalCpus: cpus().length }, fixture: { sessions: ids.length, historyCount, samples: sampleCount, warmups: 3, concurrency: 1, storage: 'SQLite snapshot imported into PostgreSQL on /data', hardwareLoad: 'host services continue; benchmark database isolated', http: 'local HTTP, fetch keep-alive, complete response, alternating sessions/health', now }, importMs, passive, eventLoop: distribution(lagMs), databaseStats, cases }, null, 2))
} finally {
    if (timer) clearInterval(timer)
    await hub?.stop()
    await store?.close()
    await sql?.close()
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    await admin.close()
    rmSync(dir, { recursive: true, force: true })
}
