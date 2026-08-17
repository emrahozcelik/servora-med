import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { JobDetailPanel } from '../src/JobDetail';
import type { JobCard } from '../src/jobs/jobs-api';
import type { CurrentUser, DeliveryItem } from '../src/services/api';
import { workflowContext } from './fixtures/job-workflow';

const manager: CurrentUser = {
  id: 'manager-1', organizationId: 'org-1', name: 'Murat', email: 'murat@example.com',
  role: 'MANAGER', mustChangePassword: false,
};
const delivery = {
  id: 'job-1', organizationId: 'org-1', organizationTimezone: 'America/New_York',
  type: 'PRODUCT_DELIVERY', status: 'WAITING_APPROVAL', version: 4,
  title: 'Klinik ürün teslimi', description: null, customerId: 'customer-1',
  contactId: 'historical-contact', assignedTo: 'staff-1', createdBy: 'manager-1',
  priority: 'normal', dueDate: null, scheduledAt: '2026-07-20T09:00:00.000Z',
  scheduledEndsAt: '2026-07-20T09:30:00.000Z', engagementKind: null,
  assignee: { id: 'staff-1', name: 'Ayşe' },
  customer: { id: 'customer-1', name: 'Klinik' },
  contact: { id: 'historical-contact', name: 'Dr. Tarihsel' },
  workflowContext: {
    ...workflowContext,
    allowedCommands: [],
    allowedActions: [],
    lifecycle: {
      ...workflowContext.lifecycle,
      submittedAt: '2026-07-17T01:30:00.000Z',
      submittedBy: { id: 'staff-1', name: 'Ayşe' },
    },
  },
  followUpContext: null,
  followUpProposal: null,
} satisfies JobCard & { organizationTimezone: string };
const item: DeliveryItem = {
  id: 'item-1', organizationId: 'org-1', jobCardId: 'job-1', productId: 'product-1',
  deliveryPurpose: 'SALE', deliveredAt: '2026-07-17T03:00:00.000Z', quantity: 1,
  unit: 'adet', productNameSnapshot: 'İmplant', productSkuSnapshot: 'I1',
  productModelSnapshot: null, lotNo: null, serialNo: null, expiryDate: null,
  deliveryNote: null,
};
const secondItem: DeliveryItem = {
  ...item, id: 'item-2', productId: 'product-2', productNameSnapshot: 'Cerrahi Vida',
  productSkuSnapshot: 'V2', quantity: 2, deliveredAt: null,
};

function render(job: JobCard = delivery, items: DeliveryItem[] = [item]) {
  return renderToStaticMarkup(<JobDetailPanel
    job={job}
    items={items}
    user={manager}
    pending={false}
    message=""
    onBack={() => {}}
    onCommand={() => {}}
  />);
}

describe('D5 Product Delivery detail timestamps', () => {
  it('separates workflow submission from physical delivery and uses organization timezone', () => {
    const html = render();
    expect(html).toContain('Kontrole gönderim zamanı');
    expect(html).toContain('16 Temmuz 2026');
    expect(html).toContain('21:30');
    expect(html).toContain('Gerçekleşen teslim zamanı');
    expect(html).toContain('Dr. Tarihsel');
  });

  it('renders a missing server submission timestamp honestly', () => {
    const html = render({
      ...delivery,
      workflowContext: {
        ...delivery.workflowContext,
        lifecycle: { ...delivery.workflowContext.lifecycle, submittedAt: null, submittedBy: null },
      },
    });
    expect(html).toContain('Kontrole gönderim zamanı');
    expect(html).toContain('Henüz kontrole gönderilmedi');
  });

  it('renders every delivery item without collapsing sibling product facts', () => {
    const html = render(delivery, [item, secondItem]);
    expect(html).toContain('İmplant');
    expect(html).toContain('I1');
    expect(html).toContain('1 adet');
    expect(html).toContain('Cerrahi Vida');
    expect(html).toContain('V2');
    expect(html).toContain('2 adet');
  });
});
