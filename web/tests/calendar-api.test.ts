import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createManualEvent,
  getCalendarEvent,
  listCalendar,
  parseCalendarEvent,
} from '../src/services/calendar-api';

afterEach(() => vi.unstubAllGlobals());

const manual = {
  id: 'event-1',
  source: 'MANUAL',
  title: 'Klinik hazırlığı',
  description: null,
  startsAt: '2026-07-26T09:00:00.000Z',
  endsAt: '2026-07-26T10:00:00.000Z',
  timezone: 'Europe/Istanbul',
  assignedUser: { id: 'staff-1', name: 'Sentetik Personel' },
  version: 1,
  canEdit: true,
  canCancel: true,
  status: 'ACTIVE',
  createdBy: { id: 'staff-1', name: 'Sentetik Personel' },
  updatedBy: { id: 'staff-1', name: 'Sentetik Personel' },
};

describe('calendar API', () => {
  it('parses the discriminated JOB/MANUAL response union', () => {
    expect(parseCalendarEvent(manual)).toMatchObject({
      source: 'MANUAL',
      status: 'ACTIVE',
      canEdit: true,
    });
    expect(parseCalendarEvent({
      ...manual,
      source: 'JOB',
      jobCardId: 'job-1',
      jobType: 'GENERAL_TASK',
      jobStatus: 'ACCEPTED',
      priority: 'normal',
      customer: null,
      relatedJobPath: '/jobs/job-1',
    })).toMatchObject({ source: 'JOB', relatedJobPath: '/jobs/job-1' });
  });

  it('parses nullable follow-up context and rejects impossible access/path combinations', () => {
    const followUp = {
      ...manual,
      source: 'JOB',
      jobCardId: 'job-1',
      jobType: 'GENERAL_TASK',
      jobStatus: 'NEW',
      priority: 'normal',
      customer: null,
      relatedJobPath: '/jobs/job-1',
      followUpContext: {
        sourceAccess: 'RESTRICTED', sourceJobPath: null,
        sourcePlannedAt: '2026-07-20T09:00:00.000Z', sourceOccurredAt: null,
        sourceCompletedAt: '2026-07-22T15:00:00.000Z',
      },
    };
    expect(parseCalendarEvent(followUp)).toMatchObject({
      source: 'JOB', followUpContext: { sourceAccess: 'RESTRICTED', sourceJobPath: null },
    });
    expect(() => parseCalendarEvent({ ...followUp, followUpContext: {
      ...followUp.followUpContext, sourceAccess: 'FULL', sourceJobPath: null,
    } })).toThrow('Takip kaynak bağlantısı');
    expect(() => parseCalendarEvent({ ...followUp, followUpContext: {
      ...followUp.followUpContext, sourceAccess: 'RESTRICTED', sourceJobPath: '/jobs/source-1',
    } })).toThrow('Takip kaynak bağlantısı');
  });

  it('uses bounded list query and explicit manual create transport', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [manual] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(manual), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(manual), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(listCalendar({
      from: '2026-07-21T00:00:00.000Z',
      to: '2026-07-28T00:00:00.000Z',
      assignedTo: 'staff-1',
    })).resolves.toHaveLength(1);
    await createManualEvent({
      clientActionId: 'create-1',
      assignedUserId: 'staff-1',
      title: 'Klinik hazırlığı',
      description: null,
      startsAt: manual.startsAt,
      endsAt: manual.endsAt,
      timezone: manual.timezone,
    });
    await expect(getCalendarEvent('event-1')).resolves.toMatchObject({
      id: 'event-1',
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/calendar?');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST' });
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain('/api/calendar/events/event-1');
  });
});
