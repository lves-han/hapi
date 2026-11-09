import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Store } from './index'
import {
    createMessageContentSearchTable,
    MAX_INDEXED_MESSAGE_CHARACTERS,
    MAX_SHORT_SEARCH_GRAMS_PER_MESSAGE,
    removeMessageContentSearchForSessions
} from './messageContentSearch'

function makeSession(store: Store, tag: string, namespace = 'default') {
    return store.sessions.getOrCreateSession(tag, { path: `/tmp/${tag}` }, null, namespace)
}

function failSessionDelete(store: Store): void {
    const db = (store as unknown as { db: Database }).db
    db.exec(`
        CREATE TRIGGER fail_session_delete
        BEFORE DELETE ON sessions
        BEGIN
            SELECT RAISE(ABORT, 'forced session delete failure');
        END
    `)
}

describe('message content search', () => {
    it('adds truncation metadata to an existing lookup schema', () => {
        const db = new Database(':memory:')
        try {
            db.exec(`
                CREATE VIRTUAL TABLE message_content_search USING fts5(
                    searchable_text,
                    message_id UNINDEXED,
                    session_id UNINDEXED,
                    seq UNINDEXED,
                    created_at UNINDEXED,
                    role UNINDEXED,
                    tokenize = 'trigram'
                );
                CREATE TABLE message_content_search_lookup (
                    search_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
                    message_id TEXT NOT NULL UNIQUE,
                    target_message_id TEXT NOT NULL
                );
            `)

            createMessageContentSearchTable(db)

            const columns = db.prepare(
                'PRAGMA table_info(message_content_search_lookup)'
            ).all() as Array<{ name: string }>
            expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
                'is_truncated',
                'short_index_truncated'
            ]))
        } finally {
            db.close()
        }
    })

    it('indexes visible user and assistant prose, including compressed messages', async () => {
        const store = new Store(':memory:')
        const session = (await makeSession(store, 'content-search'))
        await store.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: 'How do I rotate the cache key?' }
        })
        await store.messages.addMessage(session.id, {
            role: 'agent',
            content: { type: 'codex', data: { type: 'message', message: 'Use the key rotation command.' } }
        })
        await store.messages.addMessage(session.id, {
            role: 'agent',
            content: { type: 'codex', data: { type: 'tool-call', input: { text: 'cache key' } } }
        })
        await store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'codex',
                data: { type: 'message', message: `long answer ${'cache rotation '.repeat(40)}` }
            }
        })
        await store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    isMeta: true,
                    message: { content: [{ type: 'text', text: 'hidden cache rotation metadata' }] }
                }
            }
        })
        await store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    isSidechain: true,
                    message: { content: [{ type: 'text', text: 'hidden sidechain prose' }] }
                }
            }
        })

        expect((await store.messages.searchContent('rotate the cache', 'default')).map((result) => result.sessionId))
            .toEqual([session.id])
        expect((await store.messages.searchContent('rotation command', 'default'))[0]?.role).toBe('assistant')
        expect((await store.messages.searchContent('cache key', 'default'))[0]?.role).toBe('user')
        expect((await store.messages.searchContent('cache key', 'default'))[0]?.snippet).toContain('cache')
        expect((await store.messages.searchContent('hidden cache rotation', 'default'))).toEqual([])
        expect((await store.messages.searchContent('hidden sidechain prose', 'default'))).toEqual([])
    })

    it('indexes Claude assistant prose sent as a plain string content', async () => {
        const store = new Store(':memory:')
        const session = (await makeSession(store, 'content-search-string-content'))
        await store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    message: { role: 'assistant', content: 'Rotate the signing certificate yearly.' }
                }
            }
        })
        await store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    isSidechain: true,
                    message: { role: 'assistant', content: 'hidden sidechain string prose' }
                }
            }
        })

        const hits = (await store.messages.searchContent('signing certificate', 'default'))
        expect(hits.map((result) => result.sessionId)).toEqual([session.id])
        expect(hits[0]?.role).toBe('assistant')
        expect((await store.messages.searchContent('hidden sidechain string', 'default'))).toEqual([])
    })

    it('indexes only visible AGY planner prose', async () => {
        const store = new Store(':memory:')
        const session = (await makeSession(store, 'agy-content-search'))
        await store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'agy_message',
                    content: 'Visible planner answer\n[Message] timestamp=2026-07-08T06:04:31Z content=Hidden background task payload'
                }
            }
        })
        await store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'agy_message',
                    content: 'Inside the task-246 log...\n[Message] timestamp=2026-07-08T06:04:31Z content=Another hidden task payload'
                }
            }
        })

        expect((await store.messages.searchContent('Visible planner', 'default')))
            .toMatchObject([{ sessionId: session.id }])
        expect((await store.messages.searchContent('Hidden background', 'default'))).toEqual([])
        expect((await store.messages.searchContent('Another hidden', 'default'))).toEqual([])
    })

    it('excludes Claude Task prompts that render only in the tool card', async () => {
        const store = new Store(':memory:')
        const session = (await makeSession(store, 'task-prompt-search'))
        await store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    message: {
                        content: [
                            { type: 'text', text: 'Inspect the repository' },
                            { type: 'tool_use', name: 'Task', input: { prompt: 'Inspect the repository' } },
                            { type: 'text', text: 'The repository is ready.' },
                        ]
                    }
                }
            }
        })

        expect((await store.messages.searchContent('Inspect the repository', 'default'))).toEqual([])
        expect((await store.messages.searchContent('repository is ready', 'default')))
            .toMatchObject([{ sessionId: session.id }])
    })

    it('excludes injected Claude sentinel replies but keeps normal ones searchable', async () => {
        const store = new Store(':memory:')
        const session = (await makeSession(store, 'sentinel-search'))
        await store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    uuid: 'injected-turn',
                    message: { content: '<system-reminder>...</system-reminder>' }
                }
            }
        })
        await store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    parentUuid: 'injected-turn',
                    message: { content: [{ type: 'text', text: 'No response requested.' }] }
                }
            }
        })
        await store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    parentUuid: 'normal-turn',
                    message: { content: [{ type: 'text', text: 'No response requested.' }] }
                }
            }
        })

        const matches = (await store.messages.searchContent('No response requested', 'default'))
        expect(matches).toHaveLength(1)
    })

    it('updates the injected-turn cache when a later system-injected turn arrives', async () => {
        const store = new Store(':memory:')
        const session = (await makeSession(store, 'sentinel-cache'))
        await store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    parentUuid: 'normal-turn',
                    message: { content: [{ type: 'text', text: 'No response requested.' }] }
                }
            }
        })
        await store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    uuid: 'later-injected-turn',
                    message: { content: '<system-reminder>...</system-reminder>' }
                }
            }
        })
        await store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    parentUuid: 'later-injected-turn',
                    message: { content: [{ type: 'text', text: 'No response requested.' }] }
                }
            }
        })

        expect((await store.messages.searchContent('No response requested', 'default')))
            .toHaveLength(1)
    })

    it('does not return an incremental-only injected Claude sentinel hit', async () => {
        const store = new Store(':memory:')
        const session = (await makeSession(store, 'sentinel-incremental-only'))
        await store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    uuid: 'incremental-injected-turn',
                    message: { content: '<system-reminder>...</system-reminder>' }
                }
            }
        })
        await store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    parentUuid: 'incremental-injected-turn',
                    message: { content: [{ type: 'text', text: 'No response requested.' }] }
                }
            }
        })

        expect((await store.messages.searchContentInSession(
            'No response requested',
            'default',
            session.id
        ))).toEqual({ matches: [], total: 0, hasPotentiallyIncompleteResults: false })
    })

    it('uses the indexed short-query path for CJK queries and isolates namespaces', async () => {
        const store = new Store(':memory:')
        const defaultSession = (await makeSession(store, 'cjk-default'))
        const otherSession = (await makeSession(store, 'cjk-other', 'other'))
        await store.messages.addMessage(defaultSession.id, {
            role: 'user',
            content: { type: 'text', text: '中文缓存搜索测试' }
        })
        await store.messages.addMessage(otherSession.id, {
            role: 'user',
            content: { type: 'text', text: '中文缓存搜索测试' }
        })

        expect((await store.messages.searchContent('搜索', 'default')).map((result) => result.sessionId))
            .toEqual([defaultSession.id])
        expect((await store.messages.searchContent('搜索', 'other')).map((result) => result.sessionId))
            .toEqual([otherSession.id])
        expect((await store.messages.searchContent('搜', 'default'))).toEqual([])
        expect((await store.messages.searchContentInSession('搜', 'default', defaultSession.id)))
            .toEqual({ matches: [], total: 0, hasPotentiallyIncompleteResults: false })
    })

    it('bounds per-message short-index work for long high-entropy text', async () => {
        const store = new Store(':memory:')
        const session = (await makeSession(store, 'bounded-short-index'))
        const text = `${Array.from({ length: MAX_INDEXED_MESSAGE_CHARACTERS + 1024 }, (_, index) =>
            String.fromCodePoint(0x1000 + index)
        ).join('')} tail-search-needle`

        await store.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text }
        })

        const db = (store as unknown as { db: Database }).db
        const row = db.prepare(`
            SELECT rowid AS search_rowid
            FROM message_content_search
            LIMIT 1
        `).get() as { search_rowid: number }
        const indexedText = db.prepare(`
            SELECT searchable_text
            FROM message_content_search
            WHERE rowid = ?
        `).get(row.search_rowid) as { searchable_text: string }
        const count = db.prepare(`
            SELECT COUNT(*) AS count
            FROM message_content_search_short
            WHERE search_rowid = ?
        `).get(row.search_rowid) as { count: number | string }

        expect(indexedText.searchable_text.length).toBeLessThanOrEqual(MAX_INDEXED_MESSAGE_CHARACTERS)
        expect(indexedText.searchable_text).toContain('tail-search-needle')
        expect(Number(count.count)).toBeLessThanOrEqual(MAX_SHORT_SEARCH_GRAMS_PER_MESSAGE)
        expect((await store.messages.searchContent('tail-search-needle', 'default')))
            .toMatchObject([{ sessionId: session.id, truncated: true }])
        expect((await store.messages.hasPotentiallyIncompleteContent('default', 'missing-middle'))).toBe(true)
        expect((await store.messages.searchContentInSession('missing-middle', 'default', session.id)))
            .toMatchObject({ hasPotentiallyIncompleteResults: true })
    })

    it('reports incomplete coverage for two-character searches outside the short index', async () => {
        const store = new Store(':memory:')
        const session = (await makeSession(store, 'short-index-coverage'))
        const middleOnly = `${'head '.repeat(700)}middle-only-qzx ${'tail '.repeat(700)}`
        await store.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: middleOnly }
        })

        // Three-character queries use the complete bounded FTS text, while
        // the two-character path only sees the short index's head and tail.
        expect((await store.messages.searchContent('qzx', 'default')))
            .toMatchObject([{ sessionId: session.id, truncated: false }])
        expect((await store.messages.searchContentInSession('qzx', 'default', session.id)))
            .toMatchObject({ hasPotentiallyIncompleteResults: false })
        expect((await store.messages.searchContent('qz', 'default'))).toEqual([])
        expect((await store.messages.searchContentInSession('qz', 'default', session.id)))
            .toMatchObject({ matches: [], hasPotentiallyIncompleteResults: true })

        const tailMatch = `${'head '.repeat(700)}middle-only-rty ${'tail '.repeat(700)}zz`
        await store.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: tailMatch }
        })
        expect((await store.messages.searchContent('zz', 'default')))
            .toMatchObject([{ sessionId: session.id, truncated: true }])
    })

    it('defers live stream snapshots until the explicit terminal snapshot', async () => {
        const store = new Store(':memory:')
        const session = (await makeSession(store, 'live-stream-index'))
        const db = (store as unknown as { db: Database }).db
        const liveContent = (message: string) => ({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'message',
                    id: 'pi-stream-1',
                    message,
                    streamSnapshot: true,
                    live: true
                }
            }
        })

        await store.messages.addMessage(session.id, liveContent('partial response 1'))
        await store.messages.addMessage(session.id, liveContent('partial response 2'))
        expect(Number((db.prepare('SELECT COUNT(*) AS count FROM message_content_search').get() as { count: number | string }).count))
            .toBe(0)

        const terminal = (await store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'message',
                    id: 'pi-stream-1',
                    // This terminal row is intentionally identical to the
                    // latest live snapshot, as Pi emits it after an error.
                    message: 'partial response 2',
                    streamSnapshot: true
                }
            }
        }))

        expect(Number((db.prepare('SELECT COUNT(*) AS count FROM message_content_search').get() as { count: number | string }).count))
            .toBe(1)
        expect((await store.messages.searchContent('partial response 2', 'default')))
            .toMatchObject([{ sessionId: session.id, messageId: terminal.id }])
    })

    it('matches visible Markdown text rather than source delimiters', async () => {
        const store = new Store(':memory:')
        const session = (await makeSession(store, 'markdown-content-search'))
        await store.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: 'Use **KV Cache** for this path.' }
        })
        await store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'codex',
                data: { type: 'message', message: 'Use **KV Cache** for this path.' }
            }
        })

        expect((await store.messages.searchContent('KV Cache', 'default')))
            .toMatchObject([{ sessionId: session.id }])
        expect((await store.messages.searchContent('Use KV Cache', 'default')))
            .toMatchObject([{ sessionId: session.id }])
    })

    it('centers long-result snippets on a match near the indexed tail', async () => {
        const store = new Store(':memory:')
        const session = (await makeSession(store, 'snippet-near-tail'))
        await store.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: `${'unrelated prefix '.repeat(2_000)}needle near tail` }
        })

        const [result] = (await store.messages.searchContent('needle near tail', 'default'))

        expect(result?.snippet).toContain('needle near tail')
        expect(result?.snippet.length).toBeLessThan(200)
    })

    it('indexes visible non-sidechain Claude user records', async () => {
        const store = new Store(':memory:')
        const session = (await makeSession(store, 'claude-user-content-search'))
        await store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    isSidechain: false,
                    message: { content: [{ type: 'text', text: 'Find this Claude prompt.' }] }
                }
            }
        })

        expect((await store.messages.searchContent('Claude prompt', 'default')))
            .toMatchObject([{ sessionId: session.id }])
    })

    it('applies the result limit after deduplicating matching sessions', async () => {
        const store = new Store(':memory:')
        const otherSession = (await makeSession(store, 'content-search-other'))
        const busySession = (await makeSession(store, 'content-search-busy'))

        await store.messages.addMessage(otherSession.id, {
            role: 'user',
            content: { type: 'text', text: 'needle in another session' }
        })
        for (let index = 0; index < 201; index += 1) {
            await store.messages.addMessage(busySession.id, {
                role: 'user',
                content: { type: 'text', text: `needle in frequent result ${index}` }
            })
        }
        await store.sessions.touchSessionUpdatedAt(busySession.id, Date.now() + 1_000, 'default')

        expect((await store.messages.searchContent('needle', 'default', 2)).map((result) => result.sessionId))
            .toEqual([busySession.id, otherSession.id])
    })

    it('restricts global content search to requested sessions before applying the limit', async () => {
        const store = new Store(':memory:')
        const first = (await makeSession(store, 'content-search-scope-first'))
        const second = (await makeSession(store, 'content-search-scope-second'))
        for (const session of [first, second]) {
            await store.messages.addMessage(session.id, {
                role: 'user',
                content: { type: 'text', text: 'scoped needle' }
            })
        }

        expect((await store.messages.searchContent('scoped needle', 'default', 1, [second.id]))
            .map((result) => result.sessionId))
            .toEqual([second.id])
    })

    it('supports scoped content search beyond SQLite variable limits', async () => {
        const store = new Store(':memory:')
        const sessions = await Promise.all(Array.from({ length: 1001 }, async (_, index) =>
            (await makeSession(store, `large-content-scope-${index}`))
        ))
        const target = sessions.at(-1)!
        const message = (await store.messages.addMessage(target.id, {
            role: 'user',
            content: { type: 'text', text: 'large scoped needle' }
        }))

        expect((await store.messages.searchContent('large scoped needle', 'default', 1, sessions.map((session) => session.id))))
            .toMatchObject([{ sessionId: target.id, messageId: message.id }])
    })

    it('returns message-level matches and the full count for one session', async () => {
        const store = new Store(':memory:')
        const session = (await makeSession(store, 'message-level-search'))
        const older = (await store.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: 'needle in the older message' }
        }))
        const newer = (await store.messages.addMessage(session.id, {
            role: 'agent',
            content: { type: 'codex', data: { type: 'message', message: 'needle in the newer message' } }
        }))
        await store.messages.addMessage(session.id, {
            role: 'agent',
            content: { type: 'codex', data: { type: 'message', message: 'unrelated' } }
        })

        const result = (await store.messages.searchContentInSession('needle', 'default', session.id))
        expect(result.total).toBe(2)
        expect(result.matches.map((match) => match.messageId)).toEqual([newer.id, older.id])
        expect(result.matches.map((match) => match.sessionId)).toEqual([session.id, session.id])
    })

    it('collapses streamed assistant snapshots to the latest rendered message', async () => {
        const store = new Store(':memory:')
        const session = (await makeSession(store, 'streamed-content-search'))
        const firstSnapshot = (await store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'codex',
                data: { type: 'message', id: 'stream-1', message: 'old streamed needle' }
            }
        }))
        const latestSnapshot = (await store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'codex',
                data: { type: 'message', id: 'stream-1', message: 'latest streamed answer' }
            }
        }))

        expect((await store.messages.searchContent('old streamed', 'default'))).toEqual([])
        expect((await store.messages.searchContent('latest streamed', 'default'))[0]?.messageId)
            .toBe(latestSnapshot.id)
        expect((await store.messages.searchContentInSession('streamed', 'default', session.id)))
            .toMatchObject({ total: 1, matches: [{ messageId: latestSnapshot.id }] })

        const emptySnapshot = (await store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'codex',
                data: { type: 'message', id: 'stream-2', message: 'temporary streamed phrase' }
            }
        }))
        expect((await store.messages.searchContent('temporary streamed', 'default'))[0]?.messageId)
            .toBe(emptySnapshot.id)
        await store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'codex',
                data: { type: 'message', id: 'stream-2', message: '' }
            }
        })
        expect((await store.messages.searchContent('temporary streamed', 'default'))).toEqual([])
        expect(firstSnapshot.id).not.toBe(latestSnapshot.id)
    })

    it('does not expose queued messages until they are invoked', async () => {
        const store = new Store(':memory:')
        const session = (await makeSession(store, 'queued-content'))
        await store.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: 'queued secret phrase' }
        }, 'queued-1')

        expect((await store.messages.searchContent('secret phrase', 'default'))).toEqual([])
        await store.messages.markMessagesInvoked(session.id, ['queued-1'], 123)
        expect((await store.messages.searchContent('secret phrase', 'default'))[0]?.sessionId).toBe(session.id)
    })

    it('keeps the derived index in sync with deletion and session merge', async () => {
        const store = new Store(':memory:')
        const from = (await makeSession(store, 'merge-from'))
        const to = (await makeSession(store, 'merge-to'))
        const message = (await store.messages.addMessage(from.id, {
            role: 'agent',
            content: { type: 'codex', data: { type: 'message', message: 'mergeable result' } }
        }))

        expect((await store.messages.searchContent('mergeable', 'default'))[0]?.messageId).toBe(message.id)
        await store.messages.mergeSessionMessages(from.id, to.id)
        expect((await store.messages.searchContent('mergeable', 'default'))[0]?.sessionId).toBe(to.id)
        await store.sessions.deleteSession(to.id, 'default')
        expect((await store.messages.searchContent('mergeable', 'default'))).toEqual([])
    })

    it('keeps searchable content when session deletion fails after index cleanup starts', async () => {
        const store = new Store(':memory:')
        const session = (await makeSession(store, 'delete-index-rollback'))
        const message = (await store.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: 'delete rollback phrase' }
        }))
        failSessionDelete(store)

        await expect(store.sessions.deleteSession(session.id, 'default'))
            .rejects.toThrow('forced session delete failure')
        expect((await store.sessions.getSession(session.id))).not.toBeNull()
        expect((await store.messages.searchContent('delete rollback', 'default'))[0]?.messageId)
            .toBe(message.id)
    })

    it('cleans derived rows before a bulk session deletion', async () => {
        const store = new Store(':memory:')
        const first = (await makeSession(store, 'bulk-delete-first'))
        const second = (await makeSession(store, 'bulk-delete-second'))
        for (const session of [first, second]) {
            await store.messages.addMessage(session.id, {
                role: 'user',
                content: { type: 'text', text: 'bulk cleanup phrase' }
            })
        }

        const db = (store as unknown as { db: Database }).db
        removeMessageContentSearchForSessions(db, [first.id, second.id])
        db.prepare('DELETE FROM sessions WHERE id IN (?, ?)').run(first.id, second.id)

        expect((await store.messages.searchContent('bulk cleanup phrase', 'default'))).toEqual([])
    })
})
