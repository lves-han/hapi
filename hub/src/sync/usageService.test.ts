import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { getUsageSummary } from './usageService'

async function addAgentMessage(store: Store, sessionId: string, content: unknown, createdAt?: number): Promise<void> {
    if (createdAt === undefined) {
        await store.messages.addMessage(sessionId, { role: 'agent', content })
        return
    }
    await store.messages.copyMessageToSession(sessionId, {
        content: { role: 'agent', content },
        createdAt,
        localId: null,
        invokedAt: createdAt,
        scheduledAt: null
    })
}

describe('usage service', () => {
    it('normalizes historical Claude input that excludes cached tokens', async () => {
        const store = new Store(':memory:')
        const session = (await store.sessions.getOrCreateSession(
            'claude-usage-test',
            { path: '/tmp', host: 'test', flavor: 'claude' },
            null,
            'default',
            'test-model'
        ))

        await addAgentMessage(store, session.id, {
            type: 'output',
            data: {
                type: 'assistant',
                message: {
                    id: 'claude-message',
                    model: 'claude-test',
                    usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 80 }
                }
            }
        })
        await addAgentMessage(store, session.id, {
            type: 'output',
            data: {
                type: 'assistant',
                message: {
                    id: 'claude-message',
                    model: 'claude-test',
                    usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 90 }
                }
            }
        })

        const result = (await getUsageSummary(store, 'default', 'all'))
        expect(result.totals.requests).toBe(1)
        expect(result.totals.inputTokens).toBe(102)
        expect(result.totals.outputTokens).toBe(3)
        expect(result.totals.cacheReadTokens).toBe(90)
        expect(result.totals.totalTokens).toBe(105)
        expect(result.totals.uncachedTokens).toBe(15)
        expect(result.byModel.find((row) => row.key === 'claude-test')?.totalTokens).toBe(105)
        await store.close()
    })

    it('normalizes historical Codex cumulative usage with inclusive input', async () => {
        const store = new Store(':memory:')
        const session = (await store.sessions.getOrCreateSession(
            'codex-usage-test',
            { path: '/tmp', host: 'test', flavor: 'codex' },
            null,
            'default',
            'test-model'
        ))

        await addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                thread_id: 'thread-1',
                turn_id: 'turn-1',
                scope_role: 'parent',
                info: {
                    total_token_usage: { input_tokens: 1_000, output_tokens: 100, cached_input_tokens: 800 },
                    last_token_usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 80 }
                }
            }
        })
        await addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                thread_id: 'thread-2',
                turn_id: 'turn-1',
                scope_role: 'parent',
                info: {
                    total_token_usage: { input_tokens: 1_000, output_tokens: 100, cached_input_tokens: 800 },
                    last_token_usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 80 }
                }
            }
        })
        await addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                thread_id: 'thread-1',
                turn_id: 'turn-2',
                scope_role: 'parent',
                info: {
                    total_token_usage: { input_tokens: 1_140, output_tokens: 115, cached_input_tokens: 900 },
                    last_token_usage: { input_tokens: 140, output_tokens: 15, cached_input_tokens: 100 }
                }
            }
        })

        const result = (await getUsageSummary(store, 'default', 'all'))
        expect(result.totals.requests).toBe(2)
        expect(result.totals.inputTokens).toBe(240)
        expect(result.totals.outputTokens).toBe(25)
        expect(result.totals.cacheReadTokens).toBe(180)
        expect(result.totals.totalTokens).toBe(265)
        expect(result.totals.uncachedTokens).toBe(85)
        await store.close()
    })

    it('normalizes historical Kimi usage totals as inclusive per-request deltas', async () => {
        const store = new Store(':memory:')
        const session = (await store.sessions.getOrCreateSession(
            'kimi-usage-test',
            { path: '/tmp', host: 'test', flavor: 'kimi' },
            null,
            'default',
            'kimi-model'
        ))

        await addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                info: { total: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 80 } }
            }
        })
        await addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                info: { total: { inputTokens: 140, outputTokens: 15, cachedInputTokens: 100 } }
            }
        })

        const result = (await getUsageSummary(store, 'default', 'all'))
        expect(result.totals.requests).toBe(2)
        expect(result.totals.inputTokens).toBe(240)
        expect(result.totals.outputTokens).toBe(25)
        expect(result.totals.cacheReadTokens).toBe(180)
        expect(result.totals.totalTokens).toBe(265)
        expect(result.totals.uncachedTokens).toBe(85)
        await store.close()
    })

    it('recognizes the model-bearing historical generic ACP wire as inclusive', async () => {
        const store = new Store(':memory:')
        const session = (await store.sessions.getOrCreateSession(
            'acp-cache-usage-test',
            { path: '/tmp', host: 'test', flavor: 'opencode' },
            null,
            'default'
        ))

        await addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                model: 'acp-model',
                info: {
                    total: {
                        inputTokens: 13_879,
                        outputTokens: 2,
                        cachedInputTokens: 5_760
                    }
                }
            }
        })

        const result = (await getUsageSummary(store, 'default', 'all'))
        expect(result.totals.inputTokens).toBe(13_879)
        expect(result.totals.cacheReadTokens).toBe(5_760)
        expect(result.totals.totalTokens).toBe(13_881)
        expect(result.totals.uncachedTokens).toBe(8_121)
        await store.close()
    })

    it('falls back to legacy provenance when v1 usage semantics are malformed', async () => {
        const store = new Store(':memory:')
        const session = (await store.sessions.getOrCreateSession(
            'malformed-generic-usage-test',
            { path: '/tmp', host: 'test', flavor: 'opencode' },
            null,
            'default'
        ))

        await addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                usageSchema: 'hapi.usage.v1',
                inputTokenSemantics: 'unknown',
                info: {
                    total: {
                        inputTokens: 100,
                        outputTokens: 20,
                        cachedInputTokens: 40,
                        cacheWriteInputTokens: 10
                    }
                }
            }
        })

        const result = (await getUsageSummary(store, 'default', 'all'))
        expect(result.totals).toEqual(expect.objectContaining({
            inputTokens: 150,
            cacheReadTokens: 40,
            cacheCreationTokens: 10,
            totalTokens: 170
        }))
        await store.close()
    })

    it('repairs unmarked legacy generic ACP input that excluded cache', async () => {
        const store = new Store(':memory:')
        const session = (await store.sessions.getOrCreateSession(
            'legacy-generic-usage-test',
            { path: '/tmp', host: 'test', flavor: 'opencode' },
            null,
            'default'
        ))
        await addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                info: { total: { inputTokens: 100, outputTokens: 5, cachedInputTokens: 80, cacheWriteInputTokens: 20 } }
            }
        })

        const result = (await getUsageSummary(store, 'default', 'all'))
        expect(result.totals.inputTokens).toBe(200)
        expect(result.totals.cacheReadTokens).toBe(80)
        expect(result.totals.cacheCreationTokens).toBe(20)
        expect(result.totals.uncachedTokens).toBe(125)
        await store.close()
    })

    it('normalizes mixed legacy and marked generic usage per message in one session', async () => {
        const store = new Store(':memory:')
        const session = (await store.sessions.getOrCreateSession(
            'mixed-generic-usage-test',
            { path: '/tmp', host: 'test', flavor: 'opencode' },
            null,
            'default'
        ))
        const messages = [
            { type: 'token_count', info: { total: { inputTokens: 100, outputTokens: 5, cachedInputTokens: 80 } } },
            { type: 'token_count', usageSchema: 'hapi.usage.v1', inputTokenSemantics: 'includes-cache', info: { total: { inputTokens: 180, outputTokens: 5, cachedInputTokens: 80 } } },
            { type: 'token_count', model: null, info: { total: { inputTokens: 180, outputTokens: 5, cachedInputTokens: 80 } } }
        ]
        for (const data of messages) await addAgentMessage(store, session.id, { type: 'codex', data })

        const result = (await getUsageSummary(store, 'default', 'all'))
        expect(result.totals.inputTokens).toBe(540)
        expect(result.totals.outputTokens).toBe(15)
        expect(result.totals.cacheReadTokens).toBe(240)
        expect(result.totals.requests).toBe(3)
        await store.close()
    })

    it('uses the explicit v1 generic usage input semantics without double-counting cache', async () => {
        const store = new Store(':memory:')
        const session = (await store.sessions.getOrCreateSession(
            'generic-v1-usage-test',
            { path: '/tmp', host: 'test', flavor: 'opencode' },
            null,
            'default',
            'acp-model'
        ))

        await addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                usageSchema: 'hapi.usage.v1',
                inputTokenSemantics: 'includes-cache',
                info: {
                    total: {
                        inputTokens: 150,
                        outputTokens: 20,
                        cachedInputTokens: 40,
                        cacheWriteInputTokens: 10
                    }
                }
            }
        })

        const result = (await getUsageSummary(store, 'default', 'all'))
        expect(result.totals).toEqual(expect.objectContaining({
            inputTokens: 150,
            outputTokens: 20,
            cacheReadTokens: 40,
            cacheCreationTokens: 10,
            totalTokens: 170,
            uncachedTokens: 130,
            requests: 1
        }))
        await store.close()
    })

    it('normalizes cumulative total and last snapshots with the same declared semantics', async () => {
        const store = new Store(':memory:')
        const session = (await store.sessions.getOrCreateSession(
            'codex-exclusive-cumulative-test',
            { path: '/tmp', host: 'test', flavor: 'codex' },
            null,
            'default'
        ))
        const snapshots = [
            {
                total: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 80 },
                last: { inputTokens: 20, outputTokens: 2, cachedInputTokens: 10 }
            },
            {
                total: { inputTokens: 130, outputTokens: 15, cachedInputTokens: 100 },
                last: { inputTokens: 30, outputTokens: 5, cachedInputTokens: 20 }
            }
        ]
        await Promise.all(snapshots.map(async (info, index) => (await addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                usageSchema: 'hapi.usage.v1',
                inputTokenSemantics: 'excludes-cache',
                threadId: 'thread-exclusive',
                turnId: `turn-${index}`,
                info
            }
        }))))

        const result = (await getUsageSummary(store, 'default', 'all'))
        expect(result.totals).toEqual(expect.objectContaining({
            inputTokens: 80,
            outputTokens: 7,
            cacheReadTokens: 30,
            requests: 2
        }))
        await store.close()
    })

    it('treats a cumulative counter reset as a whole-snapshot reset', async () => {
        const store = new Store(':memory:')
        const session = (await store.sessions.getOrCreateSession(
            'codex-whole-reset-test',
            { path: '/tmp', host: 'test', flavor: 'codex' },
            null,
            'default'
        ))
        const snapshots = [
            {
                total: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 },
                last: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 }
            },
            {
                // Only input/cache regressed; output alone still increased.
                total: { inputTokens: 50, outputTokens: 70, cachedInputTokens: 40 },
                last: { inputTokens: 50, outputTokens: 7, cachedInputTokens: 40 }
            }
        ]
        await Promise.all(snapshots.map(async (info, index) => (await addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                threadId: 'thread-reset',
                turnId: `turn-${index}`,
                info
            }
        }))))

        const result = (await getUsageSummary(store, 'default', 'all'))
        expect(result.totals).toEqual(expect.objectContaining({
            inputTokens: 150,
            outputTokens: 27,
            cacheReadTokens: 120,
            requests: 2
        }))
        await store.close()
    })

    it('preserves primary usage and requests when the cache partition is impossible', async () => {
        const store = new Store(':memory:')
        const session = (await store.sessions.getOrCreateSession(
            'invalid-cache-partition-test',
            { path: '/tmp', host: 'test', flavor: 'opencode' },
            null,
            'default'
        ))
        await addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'usage',
                usageSchema: 'hapi.usage.v1',
                inputTokenSemantics: 'includes-cache',
                inputTokens: 100,
                outputTokens: 20,
                cachedInputTokens: 120,
                cacheWriteInputTokens: 5
            }
        })

        const result = (await getUsageSummary(store, 'default', 'all'))
        expect(result.totals).toEqual(expect.objectContaining({
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            totalTokens: 120,
            uncachedTokens: 120,
            requests: 1
        }))
        expect(result.totals.sessions).toBe(1)
        await store.close()
    })

    it('falls back to the session model for Codex events without a model', async () => {
        const store = new Store(':memory:')
        const session = (await store.sessions.getOrCreateSession(
            'codex-last-usage-test',
            { path: '/tmp', host: 'test', flavor: 'codex' },
            null,
            'default',
            'deepseek-v4-flash[1m]'
        ))

        await addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                thread_id: 'thread-1',
                turn_id: 'turn-1',
                info: {
                    last_token_usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 80 }
                }
            }
        })

        const result = (await getUsageSummary(store, 'default', 'all'))
        expect(result.totals.requests).toBe(1)
        expect(result.totals.totalTokens).toBe(110)
        expect(result.totals.uncachedTokens).toBe(30)
        expect(result.byModel).toEqual([
            expect.objectContaining({ key: 'deepseek-v4-flash[1m]', totalTokens: 110 })
        ])
        await store.close()
    })

    it('preserves an indexed fallback model across session model changes', async () => {
        const store = new Store(':memory:')
        const session = (await store.sessions.getOrCreateSession(
            'codex-model-fallback-rebuild-test',
            { path: '/tmp', host: 'test', flavor: 'codex' },
            null,
            'default',
            'deepseek-v4-flash'
        ))

        await addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                thread_id: 'thread-1',
                turn_id: 'turn-1',
                info: {
                    total_token_usage: { input_tokens: 100, output_tokens: 10 },
                    last_token_usage: { input_tokens: 100, output_tokens: 10 }
                }
            }
        })

        expect((await getUsageSummary(store, 'default', 'all')).byModel).toEqual([
            expect.objectContaining({ key: 'deepseek-v4-flash', totalTokens: 110 })
        ])

        await store.sessions.setSessionModel(session.id, 'gpt-5.6-sol', 'default')
        await store.messages.bumpMessageEpoch(session.id)

        expect((await getUsageSummary(store, 'default', 'all')).byModel).toEqual([
            expect.objectContaining({ key: 'deepseek-v4-flash', totalTokens: 110 })
        ])
        await store.close()
    })

    it('replaces a cumulative fallback model when a replay adds an explicit model', async () => {
        const store = new Store(':memory:')
        const session = (await store.sessions.getOrCreateSession(
            'codex-explicit-model-replay-test',
            { path: '/tmp', host: 'test', flavor: 'codex' },
            null,
            'default',
            'deepseek-v4-flash'
        ))
        const tokenCount = async (model?: string) => ({
            type: 'codex',
            data: {
                type: 'token_count',
                model,
                thread_id: 'thread-1',
                turn_id: 'turn-1',
                info: {
                    total_token_usage: { input_tokens: 100, output_tokens: 10 },
                    last_token_usage: { input_tokens: 100, output_tokens: 10 }
                }
            }
        })

        await addAgentMessage(store, session.id, (await tokenCount()))
        expect((await getUsageSummary(store, 'default', 'all')).byModel).toEqual([
            expect.objectContaining({ key: 'deepseek-v4-flash', totalTokens: 110, requests: 1 })
        ])

        await addAgentMessage(store, session.id, (await tokenCount('gpt-5.6-sol')))
        const result = (await getUsageSummary(store, 'default', 'all'))
        expect(result.totals).toEqual(expect.objectContaining({ totalTokens: 110, requests: 1 }))
        expect(result.byModel).toEqual([
            expect.objectContaining({ key: 'gpt-5.6-sol', totalTokens: 110, requests: 1 })
        ])
        await store.close()
    })

    it('preserves event-level models across model switches and epoch rebuilds', async () => {
        const store = new Store(':memory:')
        const session = (await store.sessions.getOrCreateSession(
            'codex-model-switch-test',
            { path: '/tmp', host: 'test', flavor: 'codex' },
            null,
            'default',
            'initial-model'
        ))

        await addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                model: 'old-model',
                thread_id: 'thread-1',
                turn_id: 'turn-1',
                info: {
                    total_token_usage: { input_tokens: 100, output_tokens: 10 },
                    last_token_usage: { input_tokens: 100, output_tokens: 10 }
                }
            }
        })
        await addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                model: 'new-model',
                thread_id: 'thread-1',
                turn_id: 'turn-2',
                info: {
                    total_token_usage: { input_tokens: 140, output_tokens: 15 },
                    last_token_usage: { input_tokens: 40, output_tokens: 5 }
                }
            }
        })
        await store.sessions.setSessionModel(session.id, 'latest-session-model', 'default')

        const expectedModels = [
            expect.objectContaining({ key: 'old-model', totalTokens: 110 }),
            expect.objectContaining({ key: 'new-model', totalTokens: 45 })
        ]
        expect((await getUsageSummary(store, 'default', 'all')).byModel).toEqual(expectedModels)

        await store.messages.bumpMessageEpoch(session.id)
        expect((await getUsageSummary(store, 'default', 'all')).byModel).toEqual(expectedModels)
        await store.close()
    })

    it('buckets historical usage with the event-specific DST offset', async () => {
        const store = new Store(':memory:')
        const session = (await store.sessions.getOrCreateSession(
            'timezone-usage-test',
            { path: '/tmp', host: 'test', flavor: 'claude' },
            null,
            'default'
        ))
        const usage = async (id: string) => ({
            type: 'output',
            data: {
                type: 'assistant',
                message: { id, usage: { input_tokens: 10, output_tokens: 2 } }
            }
        })
        await addAgentMessage(store, session.id, (await usage('before-dst')), Date.parse('2026-03-07T04:30:00Z'))
        await addAgentMessage(store, session.id, (await usage('after-dst')), Date.parse('2026-03-09T04:30:00Z'))

        expect((await getUsageSummary(store, 'default', 'all', 'America/New_York')).daily.map((row) => row.key)).toEqual([
            '2026-03-06',
            '2026-03-09'
        ])
        await store.close()
    })

    it('resumes scanning after the last checked message and resets after an epoch change', async () => {
        const store = new Store(':memory:')
        const session = (await store.sessions.getOrCreateSession(
            'incremental-usage-test',
            { path: '/tmp', host: 'test', flavor: 'claude' },
            null,
            'default',
            'test-model'
        ))
        await store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hello' } })

        const afterSeqs: number[] = []
        const getMessagesAfterSeq = store.messages.getMessagesAfterSeq.bind(store.messages)
        store.messages.getMessagesAfterSeq = async (sessionId, afterSeq) => {
            afterSeqs.push(afterSeq)
            return (await getMessagesAfterSeq(sessionId, afterSeq))
        }

        expect((await getUsageSummary(store, 'default', 'all')).totals.requests).toBe(0)
        await addAgentMessage(store, session.id, {
            type: 'output',
            data: {
                type: 'assistant',
                message: {
                    id: 'incremental-claude-message',
                    usage: { input_tokens: 5, output_tokens: 2 }
                }
            }
        })
        expect((await getUsageSummary(store, 'default', 'all')).totals.requests).toBe(1)

        await store.messages.bumpMessageEpoch(session.id)
        expect((await getUsageSummary(store, 'default', 'all')).totals.requests).toBe(1)
        expect(afterSeqs).toEqual([0, 1, 0])
        await store.close()
    })

    it('removes usage from transcript history discarded by a rewind', async () => {
        const store = new Store(':memory:')
        const session = (await store.sessions.getOrCreateSession(
            'rewound-usage-test',
            { path: '/tmp', host: 'test', flavor: 'claude' },
            null,
            'default',
            'test-model'
        ))
        const claudeUsage = async (id: string) => ({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    message: { id, usage: { input_tokens: 10, output_tokens: 2 } }
                }
            }
        })

        await store.messages.addMessage(session.id, (await claudeUsage('kept-message')))
        await store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'retry this' } },
            'rewind-point'
        )
        await store.messages.addMessage(session.id, (await claudeUsage('discarded-message')))
        expect((await getUsageSummary(store, 'default', 'all')).totals.requests).toBe(2)

        const result = (await store.messages.truncateMessagesFromLocalId(session.id, 'rewind-point'))
        expect(result.deleted).toBe(2)
        expect((await getUsageSummary(store, 'default', 'all')).totals.requests).toBe(1)
        expect((await store.usage.getEvents([session.id]))).toHaveLength(1)
        await store.close()
    })

    it('does not deduplicate matching Codex turns from different sessions', async () => {
        const store = new Store(':memory:')
        for (const [sessionId, threadId] of [['codex-session-1', 'thread-1'], ['codex-session-2', 'thread-2']] as const) {
            const session = (await store.sessions.getOrCreateSession(
                sessionId,
                { path: '/tmp', host: 'test', flavor: 'codex' },
                null,
                'default',
                'test-model'
            ))
            await addAgentMessage(store, session.id, {
                type: 'codex',
                data: {
                    type: 'token_count',
                    thread_id: threadId,
                    turn_id: 'matching-turn',
                    scope_role: 'parent',
                    info: {
                        total_token_usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 80 },
                        last_token_usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 80 }
                    }
                }
            })
        }

        const result = (await getUsageSummary(store, 'default', 'all'))
        expect(result.totals.requests).toBe(2)
        expect(result.totals.totalTokens).toBe(220)
        await store.close()
    })

    it('deduplicates repeated cumulative snapshots without thread metadata', async () => {
        const store = new Store(':memory:')
        const session = (await store.sessions.getOrCreateSession(
            'imported-codex-usage-test',
            { path: '/tmp', host: 'test', flavor: 'codex' },
            null,
            'default',
            'test-model'
        ))
        const snapshots = [
            {
                total: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 80 },
                last: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 80 }
            },
            {
                total: { inputTokens: 140, outputTokens: 15, cachedInputTokens: 100 },
                last: { inputTokens: 40, outputTokens: 5, cachedInputTokens: 20 }
            }
        ]
        for (const info of [...snapshots, ...snapshots]) {
            await addAgentMessage(store, session.id, {
                type: 'codex',
                data: { type: 'token_count', info }
            })
        }

        const result = (await getUsageSummary(store, 'default', 'all'))
        expect(result.totals.requests).toBe(2)
        expect(result.totals.inputTokens).toBe(140)
        expect(result.totals.outputTokens).toBe(15)
        expect(result.totals.uncachedTokens).toBe(55)
        await store.close()
    })

    it('excludes pre-HAPI Codex transcript usage from imported sessions', async () => {
        const store = new Store(':memory:')
        const session = (await store.sessions.getOrCreateSession(
            'resumed-codex-usage-test',
            {
                path: '/tmp',
                host: 'test',
                flavor: 'codex',
                codexSessionId: 'forked-thread',
                codexSourceSessionId: 'imported-thread'
            },
            null,
            'default',
            'test-model'
        ))

        await addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                info: {
                    total_token_usage: { input_tokens: 1_000_000, output_tokens: 10_000, cached_input_tokens: 900_000 },
                    last_token_usage: { input_tokens: 100_000, output_tokens: 1_000, cached_input_tokens: 90_000 }
                }
            }
        })
        await addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                thread_id: 'forked-thread',
                turn_id: 'managed-turn',
                info: {
                    total_token_usage: { input_tokens: 1_100_000, output_tokens: 11_000, cached_input_tokens: 990_000 },
                    last_token_usage: { input_tokens: 100_000, output_tokens: 1_000, cached_input_tokens: 90_000 }
                }
            }
        })

        const result = (await getUsageSummary(store, 'default', 'all'))
        expect(result.totals.requests).toBe(1)
        expect(result.totals.totalTokens).toBe(101_000)
        expect(result.totals.uncachedTokens).toBe(11_000)
        await store.close()
    })

    it('excludes transcript replay events explicitly marked by the CLI', async () => {
        const store = new Store(':memory:')
        const session = (await store.sessions.getOrCreateSession(
            'marked-codex-history-test',
            { path: '/tmp', host: 'test', flavor: 'codex' },
            null,
            'default',
            'test-model'
        ))

        await addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                hapiUsageScope: 'imported-history',
                info: {
                    total_token_usage: { input_tokens: 1_000_000, output_tokens: 10_000 },
                    last_token_usage: { input_tokens: 100_000, output_tokens: 1_000 }
                }
            }
        })
        await addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                hapiUsageScope: 'managed',
                thread_id: 'resumed-thread',
                info: {
                    total_token_usage: { input_tokens: 1_100_000, output_tokens: 11_000 },
                    last_token_usage: { input_tokens: 100_000, output_tokens: 1_000 }
                }
            }
        })

        const result = (await getUsageSummary(store, 'default', 'all'))
        expect(result.totals.requests).toBe(1)
        expect(result.totals.totalTokens).toBe(101_000)
        await store.close()
    })

    it('keeps usage counted once when session history is merged', async () => {
        const store = new Store(':memory:')
        const source = (await store.sessions.getOrCreateSession(
            'usage-merge-source',
            { path: '/tmp', host: 'test', flavor: 'claude' },
            null,
            'default',
            'test-model'
        ))
        const target = (await store.sessions.getOrCreateSession(
            'usage-merge-target',
            { path: '/tmp', host: 'test', flavor: 'claude' },
            null,
            'default',
            'test-model'
        ))
        await addAgentMessage(store, source.id, {
            type: 'output',
            data: {
                type: 'assistant',
                message: {
                    id: 'moved-claude-message',
                    usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 80 }
                }
            }
        })
        expect((await getUsageSummary(store, 'default', 'all')).totals.requests).toBe(1)

        const moved = (await store.messages.mergeSessionMessages(source.id, target.id))
        expect(moved.moved).toBe(1)
        await store.usage.transferSession(source.id, target.id)

        const result = (await getUsageSummary(store, 'default', 'all'))
        expect(result.totals.requests).toBe(1)
        expect((await store.usage.getEvents([source.id]))).toEqual([])
        expect((await store.usage.getEvents([target.id]))).toHaveLength(1)
        await store.close()
    })
})
