import { describe, it } from 'vitest';
import { withRetirementFixture, verifyRetirement } from '../scripts/acceptance/weekly-report-retirement.mjs';

describe.skipIf(!process.env.TEST_DATABASE_URL)('WeeklyReport retirement through actual production bootstrap (PG17)', () => {
  it('removes authenticated routes/producer and preserves complete legacy rows, manual commands and frozen history', async () => {
    await withRetirementFixture(verifyRetirement, process.env.WRRET_EVIDENCE_DIRECTORY);
  }, 60000);
});
