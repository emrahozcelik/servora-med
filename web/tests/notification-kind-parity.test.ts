import { readFileSync } from 'node:fs';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { NOTIFICATION_KINDS } from '../src/services/notifications-api';

/**
 * TG-002 regression guard: the web parser must recognize every notification
 * kind the server can emit. Reads the server contract source directly so a
 * server-side addition without the matching web change fails CI.
 */
const SERVER_TYPES_SOURCE = readFileSync(
  new URL('../../server/src/modules/notifications/types.ts', import.meta.url),
  'utf8',
);

function extractServerNotificationKinds(source: string) {
  const sourceFile = ts.createSourceFile(
    'notifications-types.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declarations: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === 'NOTIFICATION_KINDS'
    ) {
      declarations.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (declarations.length !== 1) {
    throw new Error(`Expected exactly one NOTIFICATION_KINDS declaration, found ${declarations.length}`);
  }

  let expression = declarations[0]!.initializer;
  if (expression === undefined) throw new Error('NOTIFICATION_KINDS must have an initializer');
  while (
    ts.isAsExpression(expression)
    || ts.isParenthesizedExpression(expression)
    || ts.isSatisfiesExpression(expression)
  ) {
    expression = expression.expression;
  }
  if (!ts.isArrayLiteralExpression(expression)) {
    throw new Error('NOTIFICATION_KINDS initializer must be an array literal');
  }

  return expression.elements.map((element, index) => {
    if (!ts.isStringLiteral(element)) {
      throw new Error(
        `NOTIFICATION_KINDS element ${index} must be a static string literal; received ${ts.SyntaxKind[element.kind]}`,
      );
    }
    return element.text;
  });
}

function assertNotificationKindParity(
  serverKinds: readonly string[],
  webKinds: readonly string[],
) {
  const server = new Set(serverKinds);
  const web = new Set(webKinds);
  const missingInWeb = [...server].filter((kind) => !web.has(kind));
  const extraInWeb = [...web].filter((kind) => !server.has(kind));
  if (missingInWeb.length > 0 || extraInWeb.length > 0) {
    throw new Error([
      missingInWeb.length > 0 ? `missing in web: ${missingInWeb.join(', ')}` : '',
      extraInWeb.length > 0 ? `unsupported by server: ${extraInWeb.join(', ')}` : '',
    ].filter(Boolean).join('; '));
  }
}

const SERVER_NOTIFICATION_KINDS = extractServerNotificationKinds(SERVER_TYPES_SOURCE);

describe('notification kind contract parity (server ↔ web)', () => {
  it('extracts the canonical server kind list', () => {
    // Guard against silent extraction drift: the known server contract has 13 kinds.
    expect(SERVER_NOTIFICATION_KINDS.length).toBeGreaterThanOrEqual(13);
    expect(SERVER_NOTIFICATION_KINDS).toContain('job.assigned');
  });

  it('extracts server string literals without assuming a restricted name format', () => {
    const sourceWithUnusualKinds = `
      export const NOTIFICATION_KINDS = [
        'job.v2_invalidated',
        "calendar.with-hyphen",
      ] as const;
    `;

    expect(extractServerNotificationKinds(sourceWithUnusualKinds)).toEqual([
      'job.v2_invalidated',
      'calendar.with-hyphen',
    ]);
  });

  it('rejects a server-only notification kind', () => {
    expect(() => assertNotificationKindParity(
      [...SERVER_NOTIFICATION_KINDS, 'job.v2_invalidated'],
      NOTIFICATION_KINDS,
    )).toThrow(/missing in web: job\.v2_invalidated/);
  });

  it('rejects a web-only notification kind', () => {
    expect(() => assertNotificationKindParity(
      SERVER_NOTIFICATION_KINDS,
      [...NOTIFICATION_KINDS, 'web.only-kind'],
    )).toThrow(/unsupported by server: web\.only-kind/);
  });

  it('fails closed when the server contract contains a non-literal element', () => {
    const sourceWithSpread = `
      const EXTRA_NOTIFICATION_KINDS = ['message.received'] as const;
      export const NOTIFICATION_KINDS = [
        'job.assigned',
        ...EXTRA_NOTIFICATION_KINDS,
      ] as const;
    `;

    expect(() => extractServerNotificationKinds(sourceWithSpread)).toThrow(
      /must be a static string literal; received SpreadElement/,
    );
  });

  it('web recognizes exactly the server kind set including job.invalidated', () => {
    expect(() => assertNotificationKindParity(
      SERVER_NOTIFICATION_KINDS,
      NOTIFICATION_KINDS,
    )).not.toThrow();
    expect(NOTIFICATION_KINDS).toContain('job.invalidated');
  });
});
