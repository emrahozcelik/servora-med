import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const launchdDir = fileURLToPath(new URL('../../ops/launchd', import.meta.url));

describe('launchd pilot templates', () => {
  const files = readdirSync(launchdDir).filter((name) => name.endsWith('.plist.example'));

  it('ships API and backup examples', () => {
    expect(files).toEqual(expect.arrayContaining([
      'com.servora-med.api.plist.example',
      'com.servora-med.backup.plist.example',
    ]));
  });

  it.each(files)('%s uses absolute program path and no secret literals', (name) => {
    const raw = readFileSync(path.join(launchdDir, name), 'utf8');
    // Comments may document forbidden patterns; enforce rules on executable plist only.
    const body = raw.replace(/<!--[\s\S]*?-->/g, '');
    expect(raw).toMatch(/<\?xml version="1\.0"/);
    expect(raw).toMatch(/<!DOCTYPE plist/);
    expect(body).toMatch(/<key>ProgramArguments<\/key>/);
    expect(body).toMatch(/<string>\/[^<]+<\/string>/);
    expect(body).not.toMatch(/password|DATABASE_URL|BOOTSTRAP_ADMIN|gho_/i);
    expect(body).not.toMatch(/<string>\.\/|npm run |node dist/i);
  });

  it('API template restarts at boot and stays alive', () => {
    const body = readFileSync(path.join(launchdDir, 'com.servora-med.api.plist.example'), 'utf8');
    expect(body).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(body).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(body).toMatch(/\/usr\/local\/libexec\/servora-med\/start-api\.sh/);
  });

  it('backup template uses calendar interval and absolute wrapper', () => {
    const body = readFileSync(path.join(launchdDir, 'com.servora-med.backup.plist.example'), 'utf8');
    expect(body).toMatch(/<key>StartCalendarInterval<\/key>/);
    expect(body).toMatch(/\/usr\/local\/libexec\/servora-med\/run-backup\.sh/);
  });
});
