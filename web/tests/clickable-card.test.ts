/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';

import { isInteractiveTarget } from '../src/ui/clickable-card';

describe('isInteractiveTarget', () => {
  it('returns false for null and non-elements', () => {
    expect(isInteractiveTarget(null)).toBe(false);
    expect(isInteractiveTarget(document.createTextNode('x'))).toBe(false);
  });

  it('detects interactive controls and nested content inside them', () => {
    const button = document.createElement('button');
    const span = document.createElement('span');
    button.append(span);
    document.body.append(button);
    expect(isInteractiveTarget(button)).toBe(true);
    expect(isInteractiveTarget(span)).toBe(true);

    const link = document.createElement('a');
    link.href = '/customers/1';
    document.body.append(link);
    expect(isInteractiveTarget(link)).toBe(true);

    const plain = document.createElement('div');
    document.body.append(plain);
    expect(isInteractiveTarget(plain)).toBe(false);

    button.remove();
    link.remove();
    plain.remove();
  });
});
