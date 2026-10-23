import type { Database } from './database'

import type { StoredMachine, VersionedUpdateResult } from './types'
import {
    getMachine,
    getMachineByNamespace,
    getMachines,
    getMachinesByNamespace,
    getOrCreateMachine,
    updateMachineRunnerState,
    updateMachineMetadata
} from './machines'

export class MachineStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    async getOrCreateMachine(id: string, metadata: unknown, runnerState: unknown, namespace: string): Promise<StoredMachine> {
        return this.db.operation(() => getOrCreateMachine(this.db, id, metadata, runnerState, namespace), true)
    }

    async updateMachineMetadata(
        id: string,
        metadata: unknown,
        expectedVersion: number,
        namespace: string
    ): Promise<VersionedUpdateResult<unknown | null>> {
        return this.db.operation(() => updateMachineMetadata(this.db, id, metadata, expectedVersion, namespace), true)
    }

    async updateMachineRunnerState(
        id: string,
        runnerState: unknown,
        expectedVersion: number,
        namespace: string
    ): Promise<VersionedUpdateResult<unknown | null>> {
        return this.db.operation(() => updateMachineRunnerState(this.db, id, runnerState, expectedVersion, namespace), true)
    }

    async getMachine(id: string): Promise<StoredMachine | null> {
        return this.db.operation(() => getMachine(this.db, id), false)
    }

    async getMachineByNamespace(id: string, namespace: string): Promise<StoredMachine | null> {
        return this.db.operation(() => getMachineByNamespace(this.db, id, namespace), false)
    }

    async getMachines(): Promise<StoredMachine[]> {
        return this.db.operation(() => getMachines(this.db), false)
    }

    async getMachinesByNamespace(namespace: string): Promise<StoredMachine[]> {
        return this.db.operation(() => getMachinesByNamespace(this.db, namespace), false)
    }
}
