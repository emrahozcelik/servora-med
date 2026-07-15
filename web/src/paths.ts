const encoded = (value: string) => encodeURIComponent(value);

export const paths = {
  jobs: '/jobs',
  newDelivery: '/jobs/new-delivery',
  users: '/users',
  staff: '/staff',
  reports: '/reports',
  deliveryReports: '/reports/deliveries',
  approvalReports: '/reports/approvals',
  customers: '/customers',
  newCustomer: '/customers/new',
  products: '/products',
  newProduct: '/products/new',
  job: (id: string) => `/jobs/${encoded(id)}`,
  staffProfile: (id: string) => `/staff/${encoded(id)}`,
  staffReport: (id: string) => `/staff/${encoded(id)}/reports`,
  customer: (id: string) => `/customers/${encoded(id)}`,
  product: (id: string) => `/products/${encoded(id)}`,
  contact: (customerId: string, contactId: string) =>
    `/customers/${encoded(customerId)}/contacts/${encoded(contactId)}`,
} as const;
