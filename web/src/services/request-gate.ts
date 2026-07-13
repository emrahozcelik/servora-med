export function createRequestGate() {
  let generation = 0;
  return {
    next: () => ++generation,
    current: () => generation,
    isCurrent: (candidate: number) => candidate === generation,
  };
}
