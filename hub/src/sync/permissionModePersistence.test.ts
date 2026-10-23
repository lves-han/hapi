import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

async function createEngine(store?: Store): Promise<SyncEngine> {
    const engine = await SyncEngine.create(
        store ?? new Store(':memory:'),
        {} as never,
        new RpcRegistry(),
        { broadcast() {} } as never
    )
    await engine.stop()
    return engine
}

async function simulateHubRestart(store: Store): Promise<SyncEngine> {
    return (await createEngine(store))
}

describe('permission mode persistence', () => {
    it('restores permission mode from keepalive after hub restart', async () => {
        const store = new Store(':memory:')
        const engine = (await createEngine(store))

        const session = (await engine.getOrCreateSession(
            'permission-mode-keepalive',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
            { requests: {}, completedRequests: {} },
            'default'
        ))

        await engine.handleSessionAlive({
            sid: session.id,
            time: Date.now(),
            permissionMode: 'bypassPermissions'
        })

        const reloadedEngine = (await simulateHubRestart(store))
        const reloadedSession = (await reloadedEngine.getSession(session.id))

        expect(reloadedSession?.metadata?.preferredPermissionMode).toBe('bypassPermissions')
        expect(reloadedSession?.permissionMode).toBe('bypassPermissions')
    })

    it('restores permission mode from applySessionConfig after hub restart', async () => {
        const store = new Store(':memory:')
        const engine = (await createEngine(store))

        const session = (await engine.getOrCreateSession(
            'permission-mode-config',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            { requests: {}, completedRequests: {} },
            'default'
        ))

        await engine.applySessionConfig(session.id, { permissionMode: 'yolo' })

        const reloadedEngine = (await simulateHubRestart(store))
        const reloadedSession = (await reloadedEngine.getSession(session.id))

        expect(reloadedSession?.metadata?.preferredPermissionMode).toBe('yolo')
        expect(reloadedSession?.permissionMode).toBe('yolo')
    })

    it('shows persisted permission mode before keepalive after hub restart', async () => {
        const store = new Store(':memory:')
        const engine = (await createEngine(store))

        const session = (await engine.getOrCreateSession(
            'permission-mode-active-restart',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
            { requests: {}, completedRequests: {} },
            'default'
        ))

        await engine.handleSessionAlive({
            sid: session.id,
            time: Date.now(),
            permissionMode: 'bypassPermissions'
        })

        const reloadedEngine = (await simulateHubRestart(store))
        const reloadedSession = (await reloadedEngine.getSession(session.id))

        expect(reloadedSession?.active).toBe(false)
        expect(reloadedSession?.permissionMode).toBe('bypassPermissions')
    })

    it('passes persisted permission mode when resuming after hub restart', async () => {
        const store = new Store(':memory:')
        const engine = (await createEngine(store))

        const machine = (await engine.getOrCreateMachine(
            'machine-1',
            { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
            null,
            'default'
        ))
        await engine.handleMachineAlive({ machineId: machine.id, time: Date.now() })

        const session = (await engine.getOrCreateSession(
            'resume-permission-mode-restart',
            {
                path: '/tmp/project',
                host: 'localhost',
                machineId: machine.id,
                flavor: 'codex',
                codexSessionId: 'resume-token'
            },
            { requests: {}, completedRequests: {} },
            'default'
        ))

        await engine.handleSessionAlive({
            sid: session.id,
            time: Date.now(),
            permissionMode: 'yolo'
        })
        await engine.handleSessionEnd({ sid: session.id, time: Date.now() })

        const restartedEngine = (await simulateHubRestart(store))
        await restartedEngine.handleMachineAlive({ machineId: machine.id, time: Date.now() })

        let capturedSpawnPermissionMode: string | undefined
        let configRpcCalls = 0
        ;(restartedEngine as any).rpcGateway.spawnSession = async (
            _machineId: string,
            _directory: string,
            _agent: string,
            _model?: string,
            _modelReasoningEffort?: string,
            _yolo?: boolean,
            _sessionType?: string,
            _worktreeName?: string,
            _resumeSessionId?: string,
            _effort?: string,
            permissionMode?: string
        ) => {
            capturedSpawnPermissionMode = permissionMode
            await restartedEngine.handleSessionAlive({
                sid: session.id,
                time: Date.now(),
                permissionMode: permissionMode as never
            })
            return { type: 'success', sessionId: session.id }
        }
        ;(restartedEngine as any).rpcGateway.requestSessionConfig = async () => {
            configRpcCalls += 1
            throw new Error('RPC handler not registered')
        }
        ;(restartedEngine as any).waitForSessionActive = async () => true

        const result = await restartedEngine.resumeSession(session.id, 'default')

        expect(result).toEqual({ type: 'success', sessionId: session.id })
        expect(capturedSpawnPermissionMode).toBe('yolo')
        expect(configRpcCalls).toBe(0)
    })

})
