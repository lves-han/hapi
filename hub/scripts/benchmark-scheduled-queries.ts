// Run from the repository root: bun run hub/scripts/benchmark-scheduled-queries.ts
// Generates synthetic data in memory; writes only measurements to stdout.
import assert from 'node:assert/strict'
import { arch, cpus, release, totalmem } from 'node:os'
import { Store } from '../src/store'

const sessionCount = 177
const historyCount = 510_420
const now = 2_000_000_000_000
const warmups = 3
const samples = 20
const store = new Store(':memory:')
const db = store.sqliteDatabase
const sessionIds = Array.from({ length: sessionCount }, (_, i) => `session-${i}`)

async function measure(run: () => Map<string, number> | Promise<Map<string, number>>, expected: Map<string, number>) {
    for (let i = 0; i < warmups; i++) assert.deepEqual(await run(), expected)
    const timings: { wallMs: number; cpuMs: number }[] = []
    for (let i = 0; i < samples; i++) {
        const cpuStart = process.cpuUsage()
        const start = performance.now()
        const result = await run()
        const wallMs = performance.now() - start
        const cpu = process.cpuUsage(cpuStart)
        assert.deepEqual(result, expected)
        timings.push({ wallMs, cpuMs: (cpu.user + cpu.system) / 1_000 })
    }
    const sorted = timings.map(({ wallMs }) => wallMs).sort((a, b) => a - b)
    return { p50Ms: sorted[Math.ceil(samples * 0.5) - 1], p95Ms: sorted[Math.ceil(samples * 0.95) - 1], timings }
}

try {
    db.transaction(() => {
        const insertSession = db.prepare(`
            INSERT INTO sessions (id, namespace, created_at, updated_at, seq)
            VALUES (?, 'default', 0, 0, 0)
        `)
        for (const id of sessionIds) insertSession.run(id)
        db.exec(`
            WITH RECURSIVE history(n) AS (
                SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < ${historyCount}
            )
            INSERT INTO messages (id, session_id, content, created_at, seq, local_id, invoked_at)
            SELECT 'history-' || n, 'session-' || (n % ${sessionCount}), '{}', 0, n, 'local-' || n, 0
            FROM history
        `)
    })()

    const cases: {
        pendingCount: number
        query: string
        resultRows: number
        originalPlan: unknown[]
        indexedPlan: unknown[]
        original: Awaited<ReturnType<typeof measure>>
        optimized: Awaited<ReturnType<typeof measure>>
    }[] = []
    for (const pendingCount of [0, 1, 1_000]) {
        db.transaction(() => {
            db.exec('DELETE FROM messages WHERE scheduled_at IS NOT NULL')
            const insert = db.prepare(`
                INSERT INTO messages (id, session_id, content, created_at, seq, local_id, scheduled_at)
                VALUES (?, ?, '{}', 0, ?, ?, ?)
            `)
            for (let i = 0; i < pendingCount; i++) {
                insert.run(`scheduled-${i}`, sessionIds[i % sessionCount], historyCount + i + 1, `scheduled-${i}`, now + i + 1)
            }
        })()

        for (const { name, expression, run } of [
            { name: 'scheduled_count', expression: 'COUNT(*)', run: () => store.messages.countFutureScheduledBySessionIds(sessionIds, now) },
            { name: 'scheduled_min', expression: 'MIN(scheduled_at)', run: () => store.messages.minFutureScheduledAtBySessionIds(sessionIds, now) }
        ]) {
            // Reference SQL is the original production query, with only the result alias changed.
            const originalSql = `
                SELECT session_id, ${expression} AS value
                FROM messages
                WHERE session_id IN (${sessionIds.map(() => '?').join(',')})
                  AND invoked_at IS NULL
                  AND local_id IS NOT NULL
                  AND scheduled_at IS NOT NULL
                  AND scheduled_at > ?
                  AND delivery_state = 'queued'
                GROUP BY session_id
            `
            const indexedSql = originalSql.replace('FROM messages', 'FROM messages INDEXED BY idx_messages_scheduled_pending')
            const original = db.prepare(originalSql)
            const reference = () => {
                const rows = original.all(...sessionIds, now) as { session_id: string; value: number }[]
                return new Map(rows.map(({ session_id, value }) => [session_id, value]))
            }
            const expected = new Map<string, number>()
            for (let i = 0; i < pendingCount; i++) {
                const id = sessionIds[i % sessionCount]
                expected.set(id, name === 'scheduled_count'
                    ? (expected.get(id) ?? 0) + 1
                    : Math.min(expected.get(id) ?? Infinity, now + i + 1))
            }

            // Both plans run against the same immutable data in one read transaction.
            db.exec('BEGIN')
            try {
                cases.push({
                    pendingCount,
                    query: name,
                    resultRows: expected.size,
                    originalPlan: db.query(`EXPLAIN QUERY PLAN ${originalSql}`).all(...sessionIds, now),
                    indexedPlan: db.query(`EXPLAIN QUERY PLAN ${indexedSql}`).all(...sessionIds, now),
                    original: await measure(reference, expected),
                    optimized: await measure(run, expected)
                })
            } finally { db.exec('ROLLBACK') }
            original.finalize()
        }
    }
    console.log(JSON.stringify({
        recordedAt: new Date().toISOString(),
        environment: { bun: Bun.version, sqlite: db.query('SELECT sqlite_version() AS version').get(), arch: arch(), kernel: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem() },
        fixture: { storage: 'in-memory', sessionCount, historyCount, history: 'all rows have local_id and invoked_at = 0; scheduled_at = NULL', statistics: 'no ANALYZE, matching fresh schema defaults', warmups, samples, now, concurrency: 1, backgroundTraffic: 'none in fixture; host load uncontrolled' },
        cases
    }, null, 2))
} finally {
    await store.close()
}
