import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const jobDetailSource = readFileSync(resolve(testDirectory, '../src/JobDetail.tsx'), 'utf8');
const deliveryAssigneeSource = readFileSync(
  resolve(testDirectory, '../src/jobs/DeliveryAssigneeEditForm.tsx'),
  'utf8',
);
const generalTaskSource = readFileSync(
  resolve(testDirectory, '../src/jobs/GeneralTaskEditForm.tsx'),
  'utf8',
);
const salesMeetingSource = readFileSync(
  resolve(testDirectory, '../src/jobs/SalesMeetingEditForm.tsx'),
  'utf8',
);
const meetingDetailsSource = readFileSync(
  resolve(testDirectory, '../src/jobs/MeetingDetails.tsx'),
  'utf8',
);
const stylesSource = readFileSync(resolve(testDirectory, '../src/styles.css'), 'utf8');

describe('inline JobDetail form action spacing', () => {
  it('gives Product Delivery actual-time save a scoped action-spacing contract', () => {
    expect(jobDetailSource).toMatch(
      /<div className="review-buttons inline-form-actions">[\s\S]*Gerçekleşen teslim zamanını kaydet/,
    );
    expect(stylesSource).toMatch(
      /\.inline-form-actions\s*\{[^}]*margin-top:\s*1rem;/s,
    );
  });

  it('gives Product Delivery assignee edit a scoped action-spacing contract', () => {
    expect(deliveryAssigneeSource).toMatch(
      /<div className="review-buttons inline-form-actions">[\s\S]*Vazgeç[\s\S]*Değişiklikleri kaydet/,
    );
  });

  it('gives General Task edit a scoped action-spacing contract', () => {
    expect(generalTaskSource).toMatch(
      /<div className="review-buttons inline-form-actions">[\s\S]*Vazgeç[\s\S]*Değişiklikleri kaydet/,
    );
  });

  it('gives Sales Meeting edit a scoped action-spacing contract', () => {
    expect(salesMeetingSource).toMatch(
      /<div className="review-buttons inline-form-actions">[\s\S]*Vazgeç[\s\S]*Değişiklikleri kaydet/,
    );
  });

  it('gives Meeting result save a scoped action-spacing contract', () => {
    expect(meetingDetailsSource).toMatch(
      /<div className="review-buttons inline-form-actions">[\s\S]*Görüşme sonucunu kaydet/,
    );
  });

  it('keeps existing schedule spacing scoped instead of widening review-buttons globally', () => {
    expect(stylesSource).toMatch(
      /\.job-schedule-edit \.review-buttons\s*\{[^}]*margin-top:\s*1rem;/s,
    );
    expect(stylesSource).not.toMatch(
      /(?:^|\n)\.review-buttons\s*\{[^}]*margin-top:\s*1rem;/s,
    );
  });
});
