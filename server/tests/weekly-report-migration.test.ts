import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const migrationUrl = new URL('../src/db/migrations/051_weekly_report_foundation.sql', import.meta.url);

describe('051 weekly report foundation migration', () => {
  let sql = '';

  beforeAll(async () => {
    sql = await readFile(fileURLToPath(migrationUrl), 'utf8');
  });

  it('extends the job_cards type CHECK with WEEKLY_REPORT and keeps existing literals', () => {
    expect(sql).toContain('ADD CONSTRAINT job_cards_type_check');
    expect(sql).toMatch(/CHECK \(type IN \(\s*'PRODUCT_DELIVERY', 'GENERAL_TASK', 'SALES_MEETING', 'WEEKLY_REPORT'\s*\)\)/);
  });

  it('creates the weekly_reports identity/draft table with the V1 invariant', () => {
    expect(sql).toContain('CREATE TABLE weekly_reports');
    expect(sql).toContain('UNIQUE (organization_id, job_card_id)');
    expect(sql).toContain('UNIQUE (organization_id, staff_user_id, period_start)');
    expect(sql).toContain('period_end = period_start + 6');
    expect(sql).toContain('EXTRACT(ISODOW FROM period_start) = 1');
    for (const field of [
      'draft_summary', 'draft_blockers', 'draft_next_week_plan',
      'draft_highlights', 'draft_field_observations', 'draft_support_needed',
    ]) {
      expect(sql).toContain(field);
    }
    expect(sql).toContain('manager_questions JSONB');
    expect(sql).toContain('manager_answers JSONB');
  });

  it('creates the append-only weekly_report_submissions table', () => {
    expect(sql).toContain('CREATE TABLE weekly_report_submissions');
    expect(sql).toContain('UNIQUE (organization_id, weekly_report_id, seq_no)');
    for (const column of [
      'frozen_body', 'frozen_questions', 'frozen_answers', 'frozen_source_work',
      'period_start', 'period_end', 'source_activity_id', 'job_version',
    ]) {
      expect(sql).toContain(column);
    }
    expect(sql).toContain(
      'REFERENCES job_card_activity_logs (organization_id, job_card_id, id)',
    );
  });

  it('fails closed when the type contract did not widen', () => {
    expect(sql).toContain('job_cards type CHECK must accept WEEKLY_REPORT');
  });

  it('performs no backfill or reinterpretation of historical rows', () => {
    expect(sql).not.toMatch(/UPDATE\s+job_cards/i);
    expect(sql).not.toMatch(/INSERT INTO weekly_reports\s*\(/i);
    expect(sql).not.toMatch(/INSERT INTO weekly_report_submissions\s*\(/i);
  });
});
