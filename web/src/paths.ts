const encoded = (value: string) => encodeURIComponent(value);

export const paths = {
  jobs: '/jobs',
  newDelivery: '/jobs/new-delivery',
  users: '/users',
  staff: '/staff',
  customers: '/customers',
  newCustomer: '/customers/new',
  products: '/products',
  newProduct: '/products/new',
  job: (id: string) => `/jobs/${encoded(id)}`,
  staffProfile: (id: string) => `/staff/${encoded(id)}`,
  customer: (id: string) => `/customers/${encoded(id)}`,
  product: (id: string) => `/products/${encoded(id)}`,
  contact: (customerId: string, contactId: string) =>
    `/customers/${encoded(customerId)}/contacts/${encoded(contactId)}`,
} as const;
