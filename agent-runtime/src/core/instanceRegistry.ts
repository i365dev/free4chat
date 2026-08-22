export interface ResidentInstanceRecord {
  instanceId: string
  roomId: string
}

export class InstanceRegistry<T extends ResidentInstanceRecord> {
  private readonly valuesById = new Map<string, T>()

  set(value: T): void {
    this.valuesById.set(value.instanceId, value)
  }

  get(instanceId: string): T | undefined {
    return this.valuesById.get(instanceId)
  }

  delete(instanceId: string): boolean {
    return this.valuesById.delete(instanceId)
  }

  values(): T[] {
    return [...this.valuesById.values()]
  }
}
