import { describe, expect, it } from 'bun:test'
import { Store } from './index'

describe('Store namespace filtering', () => {
    it('filters sessions by namespace', async () => {
        const store = new Store(':memory:')
        const sessionAlpha = (await store.sessions.getOrCreateSession('tag', { path: '/alpha' }, null, 'alpha'))
        const sessionBeta = (await store.sessions.getOrCreateSession('tag', { path: '/beta' }, null, 'beta'))

        const sessionsAlpha = (await store.sessions.getSessionsByNamespace('alpha'))
        const ids = sessionsAlpha.map((session) => session.id)

        expect(ids).toContain(sessionAlpha.id)
        expect(ids).not.toContain(sessionBeta.id)
    })

    it('filters machines by namespace and blocks mismatches', async () => {
        const store = new Store(':memory:')
        const machineAlpha = (await store.machines.getOrCreateMachine('machine-1', { host: 'alpha' }, null, 'alpha'))
        await store.machines.getOrCreateMachine('machine-2', { host: 'beta' }, null, 'beta')

        const machinesAlpha = (await store.machines.getMachinesByNamespace('alpha'))
        const ids = machinesAlpha.map((machine) => machine.id)

        expect(ids).toContain(machineAlpha.id)
        expect(ids).not.toContain('machine-2')
        expect(async () => (await store.machines.getOrCreateMachine('machine-1', { host: 'beta' }, null, 'beta'))).toThrow()
    })
})
