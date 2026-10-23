import { resolve } from 'node:path'
import { exportPostgres } from '../src/store/exportPostgres'

const output = process.argv[2]
if (!process.env.DATABASE_URL || !output || process.argv.length !== 3) {
    throw new Error('Usage: DATABASE_URL=postgresql://... bun run hub/scripts/export-postgres-to-sqlite.ts /data/hapi/export.sqlite')
}
await exportPostgres(process.env.DATABASE_URL, resolve(output))
console.log('Verified SQLite export complete. Keep Hub stopped until the database and sidecar files have been switched.')
