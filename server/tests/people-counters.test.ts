import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { PeopleService } from '../src/modules/people/service.js';
import type { StaffProfileDetails } from '../src/modules/people/types.js';

const now = new Date('2026-07-14T12:00:00.000Z');
const ORG_ONE = 'org-1';
const STAFF_ONE = 'staff-1';
const STAFF_TWO = 'staff-2';

const actor = (role: 'ADMIN' | 'MANAGER' | 'STAFF', id: string) => ({
  id,
  organizationId: ORG_ONE,
  name: role,
  email: `${role.toLowerCase()}@example.com`,
  role,
  mustChangePassword: false,
  isActive: true,
  version: 1,
});
const ADMIN = actor('ADMIN', 'admin-1');
const MANAGER = actor('MANAGER', 'manager-1');
const STAFF = actor('STAFF', STAFF_ONE);

function profile(userId: string, isActive = true): StaffProfileDetails {
  return {
    id: `profile-${userId}`,
    user: {
      id: userId,
      organizationId: ORG_ONE,
      name: `Personel ${userId}`,
      email: `${userId}@example.com`,
      role: 'STAFF',
      mustChangePassword: false,
      isActive,
      version: 1,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
    },
    title: null,
    phone: null,
    region: null,
    managerUserId: null,
    managerName: null,
    version: 1,
  };
}

function operationalSummary(staffUserId: string, seed: number) {
  return {
    staffUserId,
    range: { from: '2026-07-01', to: '2026-07-31', timezone: 'Europe/Istanbul' },
    counters: {
      openJobCards: seed,
      waitingApproval: seed + 1,
      revisionRequested: seed + 2,
      overdueJobCards: seed + 3,
      completedInPeriod: seed + 4,
    },
  };
}

function setup() {
  const profiles = [profile(STAFF_ONE), profile(STAFF_TWO, false)];
  const summaries = new Map([
    [STAFF_ONE, operationalSummary(STAFF_ONE, 3)],
    [STAFF_TWO, operationalSummary(STAFF_TWO, 10)],
  ]);
  const repository = {
    listStaffProfiles: vi.fn(async (_organizationId, status) => profiles.filter((item) => (
      status === 'all' || item.user.isActive === (status === 'active')
    ))),
    getStaffProfile: vi.fn(async (_organizationId, userId) => (
      profiles.find((item) => item.user.id === userId) ?? null
    )),
  };
  const staffSummaries = {
    getMany: vi.fn(async ({ staffUserIds }) => new Map(
      staffUserIds.flatMap((id: string) => {
        const summary = summaries.get(id);
        return summary ? [[id, summary] as const] : [];
      }),
    )),
    getOne: vi.fn(async ({ staffUserId }) => summaries.get(staffUserId) ?? null),
  };
  const credentials = {
    validatePassword: () => undefined,
    hashPassword: async () => 'hash',
  };
  const service = new PeopleService(
    repository as never,
    credentials,
    staffSummaries as never,
    () => now,
  );
  return { repository, staffSummaries, service };
}

describe('People canonical Staff counters', () => {
  it('loads all listed Staff counters through one batch port call', async () => {
    const { service, repository, staffSummaries } = setup();

    const result = await service.listStaff(ADMIN, 'all');

    expect(result).toEqual([
      expect.objectContaining({
        user: expect.objectContaining({ id: STAFF_ONE }),
        counters: {
          open: 3,
          waitingApproval: 4,
          revisionRequested: 5,
          completedThisMonth: 7,
          overdue: 6,
        },
      }),
      expect.objectContaining({
        user: expect.objectContaining({ id: STAFF_TWO, isActive: false }),
        counters: {
          open: 10,
          waitingApproval: 11,
          revisionRequested: 12,
          completedThisMonth: 14,
          overdue: 13,
        },
      }),
    ]);
    expect(repository.listStaffProfiles).toHaveBeenCalledWith(ORG_ONE, 'all');
    expect(staffSummaries.getMany).toHaveBeenCalledOnce();
    expect(staffSummaries.getMany).toHaveBeenCalledWith({
      organizationId: ORG_ONE,
      staffUserIds: [STAFF_ONE, STAFF_TWO],
      requestedRange: null,
      requestTime: now,
    });
    expect(staffSummaries.getOne).not.toHaveBeenCalled();
  });

  it('uses one single-summary read for own and management detail profiles', async () => {
    const own = setup();
    await expect(own.service.getOwnStaffProfile(STAFF)).resolves.toMatchObject({
      user: { id: STAFF_ONE },
      counters: { open: 3, completedThisMonth: 7 },
    });
    expect(own.staffSummaries.getOne).toHaveBeenCalledOnce();
    expect(own.staffSummaries.getMany).not.toHaveBeenCalled();
    expect(own.staffSummaries.getOne).toHaveBeenCalledWith({
      organizationId: ORG_ONE,
      staffUserId: STAFF_ONE,
      requestedRange: null,
      requestTime: now,
    });

    const detail = setup();
    await expect(detail.service.getStaffProfile(MANAGER, STAFF_ONE)).resolves.toMatchObject({
      user: { id: STAFF_ONE },
      counters: { waitingApproval: 4, overdue: 6 },
    });
    expect(detail.staffSummaries.getOne).toHaveBeenCalledOnce();
    expect(detail.staffSummaries.getMany).not.toHaveBeenCalled();
  });

  it('keeps Reports dependencies type-only and removes People-owned counter SQL', async () => {
    const peopleFiles = ['service.ts', 'types.ts', 'repository.ts'] as const;
    const peopleSources = await Promise.all(peopleFiles.map(async (file) => ({
      file,
      source: await readFile(
        new URL(`../src/modules/people/${file}`, import.meta.url),
        'utf8',
      ),
    })));
    const serviceSource = peopleSources.find(({ file }) => file === 'service.ts')?.source ?? '';
    const repositorySource = peopleSources.find(({ file }) => file === 'repository.ts')?.source ?? '';
    const peopleSource = peopleSources.map(({ source }) => source).join('\n');

    expect(serviceSource).toContain(
      "import type { StaffOperationalSummary } from '../reports/types.js';",
    );
    expect(serviceSource).toContain(
      "import type { StaffOperationalSummaryPort } from '../reports/ports.js';",
    );
    expect(peopleSource).not.toMatch(
      /import\s+(?!type\b)[^;]*from ['"]\.\.\/reports\//g,
    );
    expect(repositorySource).not.toMatch(/COUNT\(jc\.id\)|manager_approved_at|LEFT JOIN job_cards/);
  });
});
