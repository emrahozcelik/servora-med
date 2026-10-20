import { randomUUID, createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { withIntentSchema } from './support/lifecycle-intent-harness.js';
import { parseDuplicateKeyring } from '../src/modules/crm/duplicate-evidence.js';
import { PostgresDuplicateReadRepository } from '../src/modules/crm/duplicate-repository.js';
import { PostgresDuplicateReviewRepository } from '../src/modules/crm/duplicate-review-repository.js';
import { DuplicateComparisonService } from '../src/modules/crm/duplicate-service.js';
import { DuplicateReviewService } from '../src/modules/crm/duplicate-review-service.js';

const old = Buffer.alloc(32, 61).toString('base64');
const active = Buffer.alloc(32, 62).toString('base64');
const original = JSON.stringify({ activeKeyId: 'old', keys: { old } });
const rotated = JSON.stringify({ activeKeyId: 'active', keys: { active, old } });
const retired = JSON.stringify({ activeKeyId: 'active', keys: { active } });
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

it.skipIf(!process.env.TEST_DATABASE_URL)('KEY-02/03: synthetic encrypted custody, DB-only restore and planned/emergency retirement preserve immutable history', async () => {
  await withIntentSchema(process.env.TEST_DATABASE_URL, async (pool, schema) => {
    const owned = mkdtempSync(path.join(tmpdir(), 'crm-key-rehearsal-'));
    const out = process.env.CRM_DUPLICATE_REHEARSAL_OUT ?? owned;
    mkdirSync(out, { recursive: true, mode: 0o700 });
    const org = (await pool.query("INSERT INTO organizations(name) VALUES('Synthetic custody rehearsal') RETURNING id")).rows[0].id;
    const actor = { organizationId: org, id: randomUUID(), role: 'MANAGER' as const };
    await pool.query("INSERT INTO users(id,organization_id,name,email,password_hash,role) VALUES($1,$2,'Synthetic operator','synthetic@key.invalid','unused','MANAGER')", [actor.id, org]);
    const ids: string[] = [];
    for (let n = 0; n < 4; n++) ids.push((await pool.query("INSERT INTO customers(organization_id,name,customer_type,status) VALUES($1,$2,'clinic','active') RETURNING id", [org, `Synthetic clinic ${Math.floor(n / 2)}`])).rows[0].id);
    const services = (raw: string) => {
      const ring = parseDuplicateKeyring(raw);
      return { read: new DuplicateComparisonService(new PostgresDuplicateReadRepository(pool), ring), write: new DuplicateReviewService(new PostgresDuplicateReviewRepository(pool, ring)) };
    };
    const initial = services(original);
    let originalCommand: Parameters<typeof initial.write.decide>[3]; let originalReceipt;
    for (let n = 0; n < 4; n += 2) {
      const read = await initial.read.comparison(actor, ids[n]!, ids[n + 1]!);
      const command = { clientActionId: randomUUID(), expectedReviewVersion: 0,
        expectedEvidenceRevision: read.evidence.revision, matchingRuleVersion: read.evidence.matchingRuleVersion,
        decision: 'DISMISSED' as const, reasonCode: 'DISTINCT_BRANCH' as const };
      const result = await initial.write.decide(actor, ids[n]!, ids[n + 1]!, command);
      if (n === 0) { originalCommand = command; originalReceipt = result.receipt; }
    }
    const historyBefore = (await pool.query('SELECT row_to_json(e) AS event FROM customer_duplicate_review_events e ORDER BY id')).rows;
    const dependentHeads = async () => Number((await pool.query(`SELECT count(*) FROM customer_duplicate_reviews r JOIN customer_duplicate_review_events e
      ON e.organization_id=r.organization_id AND e.review_id=r.id AND e.seq=r.version WHERE e.evidence_key_id='old'`)).rows[0].count);
    expect(await dependentHeads()).toBe(2); // Routine retirement is blocked.
    const twoOnline = services(rotated); const missingOld = services(retired);
    expect(await missingOld.write.decide(actor, ids[0]!, ids[1]!, originalCommand!)).toEqual({ receipt: originalReceipt, replayed: true });
    expect((await missingOld.read.candidates(actor, { view: 'ATTENTION', anchorCustomerId: null, cursor: null, limit: 20 })).items).toHaveLength(2);
    expect((await twoOnline.read.comparison(actor, ids[0]!, ids[1]!)).review.freshness).toBe('CURRENT');
    expect((await missingOld.read.comparison(actor, ids[0]!, ids[1]!)).review).toMatchObject({ freshness: 'UNVERIFIABLE', freshnessReason: 'KEY_UNAVAILABLE', effectiveStatus: 'BLOCKED' });

    // Two independently encrypted synthetic failure-domain copies. Wrapping
    // identities exist only in process memory, outside both encrypted archives.
    const identities = [Buffer.alloc(32, 71), Buffer.alloc(32, 72)];
    const encrypted: string[] = [];
    for (let n = 0; n < 2; n++) {
      const dir = path.join(out, `synthetic-custody-domain-${n + 1}`); mkdirSync(dir, { recursive: true, mode: 0o700 });
      const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', identities[n]!, iv);
      const ciphertext = Buffer.concat([cipher.update(rotated, 'utf8'), cipher.final()]);
      const archive = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
      const file = path.join(dir, 'synthetic-keyring.aes-gcm'); writeFileSync(file, archive, { mode: 0o600 }); encrypted.push(file);
      expect(archive.includes(Buffer.from(old))).toBe(false); expect(archive.includes(Buffer.from(active))).toBe(false);
    }
    const restore = (file: string, identity: Buffer) => {
      const archive = readFileSync(file); const cipher = createDecipheriv('aes-256-gcm', identity, archive.subarray(0, 12));
      cipher.setAuthTag(archive.subarray(12, 28));
      return Buffer.concat([cipher.update(archive.subarray(28)), cipher.final()]).toString('utf8');
    };
    expect(() => restore(encrypted[0]!, identities[1]!)).toThrow();
    for (let n = 0; n < 2; n++) {
      expect(restore(encrypted[n]!, identities[n]!)).toBe(rotated);
      expect(parseDuplicateKeyring(restore(encrypted[n]!, identities[n]!)).keys.get('old')).toEqual(Buffer.from(old, 'base64'));
    }

    const url = new URL(process.env.TEST_DATABASE_URL!);
    const env = { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: url.pathname.slice(1) };
    const dump = path.join(out, 'synthetic-review-db.dump');
    try {
      const dumpBin = process.env.PG_DUMP_BIN ?? 'pg_dump'; const restoreBin = process.env.PG_RESTORE_BIN ?? 'pg_restore';
      expect(execFileSync(dumpBin, ['--version'], { encoding: 'utf8' })).toMatch(/\b17\./);
      expect(execFileSync(restoreBin, ['--version'], { encoding: 'utf8' })).toMatch(/\b17\./);
      execFileSync(dumpBin, ['--schema', schema, '--no-owner', '--no-privileges', '--format=custom', '--file', dump], { env });
      const plain = execFileSync(restoreBin, ['--file=-', dump]);
      expect(plain.includes(Buffer.from(old))).toBe(false); expect(plain.includes(Buffer.from(active))).toBe(false);
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      execFileSync(restoreBin, ['--dbname', env.PGDATABASE, '--no-owner', '--no-privileges', dump], { env });
      expect((await pool.query('SELECT row_to_json(e) AS event FROM customer_duplicate_review_events e ORDER BY id')).rows).toEqual(historyBefore);
      expect((await missingOld.read.comparison(actor, ids[0]!, ids[1]!)).review.freshness).toBe('UNVERIFIABLE'); // DB alone cannot restore the key.
      const restoredServices = services(restore(encrypted[1]!, identities[1]!));
      expect((await restoredServices.read.comparison(actor, ids[0]!, ids[1]!)).review.freshness).toBe('CURRENT');
      const read = await restoredServices.read.comparison(actor, ids[0]!, ids[1]!);
      await restoredServices.write.reopen(actor, ids[0]!, ids[1]!, { clientActionId: randomUUID(), expectedReviewVersion: 1, expectedEvidenceRevision: read.evidence.revision, matchingRuleVersion: read.evidence.matchingRuleVersion });
      const renewed = await restoredServices.read.comparison(actor, ids[0]!, ids[1]!);
      await restoredServices.write.decide(actor, ids[0]!, ids[1]!, { clientActionId: randomUUID(), expectedReviewVersion: 2, expectedEvidenceRevision: renewed.evidence.revision, matchingRuleVersion: renewed.evidence.matchingRuleVersion, decision: 'DISMISSED', reasonCode: 'DISTINCT_BRANCH' });
      expect(await missingOld.write.decide(actor, ids[0]!, ids[1]!, originalCommand!)).toEqual({ receipt: originalReceipt, replayed: true });
      await pool.query('DELETE FROM customers WHERE id=$1', [ids[2]]);
      expect(await dependentHeads()).toBe(1); // Unavailable-source head still blocks routine retirement.
      const simulatedOwnerAcceptance = { synthetic: true, dependentHeads: 1, effect: 'UNVERIFIABLE', acceptedForRehearsalOnly: true };
      const attention = await missingOld.read.candidates(actor, { view: 'ATTENTION', anchorCustomerId: null, cursor: null, limit: 20 });
      expect(attention.items).toHaveLength(0); // Renewed dismissal remains current with active key.
      expect((await pool.query('SELECT row_to_json(e) AS event FROM customer_duplicate_review_events e WHERE evidence_key_id=\'old\' ORDER BY id')).rows).toEqual(historyBefore);
      expect((await pool.query('SELECT count(*) FROM customer_duplicate_reviews')).rows[0].count).toBe('2');
      writeFileSync(path.join(out, 'key-rehearsal.json'), JSON.stringify({ status: 'PASS', syntheticOnly: true,
        plannedRetirement: { initiallyBlockedHeads: 2, renewedHeads: 1, remainingUnavailableHeads: 1, simulatedOwnerAcceptance },
        emergencyRetirement: 'UNVERIFIABLE before restore; immutable history retained',
        dbOnlyRestore: 'UNVERIFIABLE', exactIndependentCustodyRestores: 2,
        simulatedFailureDomains: true, productionCustody: 'NOT_RUN',
        encryptedArchives: encrypted.map((file) => ({ file: path.basename(path.dirname(file)), sha256: hash(readFileSync(file)) })), dbDumpSha256: hash(readFileSync(dump)) }, null, 2));
    } finally { rmSync(owned, { recursive: true, force: true }); }
  });
}, 20_000);
