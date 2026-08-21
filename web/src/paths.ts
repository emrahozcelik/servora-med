const encoded = (value: string) => encodeURIComponent(value);

export const paths = {
  overview: '/overview',
  calendar: '/calendar',
  messages: '/messages',
  jobs: '/jobs',
  docs: '/docs',
  help: '/help',
  settings: '/settings',
  settingsProfile: '/settings/profile',
  settingsSecurity: '/settings/security',
  settingsNotifications: '/settings/notifications',
  settingsApplication: '/settings/application',
  newDelivery: '/jobs/new-delivery',
  newTask: '/jobs/new-task',
  newMeeting: '/jobs/new-meeting',
  followUpCreate: (sourceJobCardId: string) =>
    `/jobs/new-follow-up?source=${encoded(sourceJobCardId)}`,
  users: '/users',
  newUser: '/users/new',
  user: (id: string) => `/users/${encoded(id)}`,
  staff: '/staff',
  reports: '/reports',
  staffPerformanceReports: '/reports/staff',
  customerReports: '/reports/customers',
  deliveryReports: '/reports/deliveries',
  approvalReports: '/reports/approvals',
  salesFollowUpReports: '/reports/sales-follow-up',
  customers: '/customers',
  newCustomer: '/customers/new',
  products: '/products',
  newProduct: '/products/new',
  job: (id: string) => `/jobs/${encoded(id)}`,
  staffProfile: (id: string) => `/staff/${encoded(id)}`,
  staffReport: (id: string, range?: { from: string; to: string } | null) => {
    const base = `/staff/${encoded(id)}/reports`;
    if (!range) return base;
    const search = new URLSearchParams({ from: range.from, to: range.to });
    return `${base}?${search.toString()}`;
  },
  customer: (id: string) => `/customers/${encoded(id)}`,
  product: (id: string) => `/products/${encoded(id)}`,
  contact: (customerId: string, contactId: string) =>
    `/customers/${encoded(customerId)}/contacts/${encoded(contactId)}`,
} as const;
