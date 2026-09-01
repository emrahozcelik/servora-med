export function createRequestGate() {
  let generation = 0;
  return {
    next: () => ++generation,
    current: () => generation,
    isCurrent: (candidate: number) => candidate === generation,
  };
}

/** Merge reference records without allowing duplicate identities. */
export function mergeById<T extends { id: string }>(current: T[], additions: T[]): T[] {
  const records = new Map(current.map((item) => [item.id, item]));
  for (const item of additions) records.set(item.id, item);
  return Array.from(records.values());
}
