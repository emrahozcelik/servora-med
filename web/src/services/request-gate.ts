export function createRequestGate() {
  let generation = 0;
  return {
    next: () => ++generation,
    current: () => generation,
    isCurrent: (candidate: number) => candidate === generation,
  };
}

/**
 * Keeps newly-created reference records only until a post-create canonical
 * response acknowledges the same identity.
 */
export function createTemporaryReferenceBuffer<T extends { id: string }>() {
  const snapshots = new Map<string, { record: T; creationGeneration: number }>();

  function mergeSnapshots(records: T[]) {
    const merged = new Map(records.map((record) => [record.id, record]));
    for (const { record } of snapshots.values()) merged.set(record.id, record);
    return Array.from(merged.values());
  }

  return {
    add(record: T, creationGeneration: number) {
      snapshots.set(record.id, { record, creationGeneration });
    },
    mergeCurrent(records: T[]) {
      return mergeSnapshots(records);
    },
    reconcile(canonical: T[], responseGeneration: number) {
      const merged = new Map(canonical.map((record) => [record.id, record]));
      for (const [id, snapshot] of snapshots) {
        if (responseGeneration > snapshot.creationGeneration && merged.has(id)) {
          snapshots.delete(id);
          continue;
        }
        merged.set(id, snapshot.record);
      }
      return Array.from(merged.values());
    },
    values() {
      return Array.from(snapshots.values(), ({ record }) => record);
    },
    has(id: string) {
      return snapshots.has(id);
    },
  };
}
