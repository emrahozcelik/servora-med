export type CounterState = 'hidden' | 'normal' | 'attention';

/**
 * Progressive character-counter policy shared across note, reason and
 * follow-up fields. Hard limits are enforced separately by each form's
 * validation contract; this only decides how the counter is presented.
 *
 * remaining > 500  → hidden
 * remaining <= 500 → visible / muted
 * remaining <= 100 → attention styling
 */
export function counterState(remaining: number): CounterState {
  if (remaining > 500) return 'hidden';
  if (remaining <= 100) return 'attention';
  return 'normal';
}
