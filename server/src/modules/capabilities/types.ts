export type AuthenticatedCapabilities = Readonly<{
  duplicateCustomerComparison?: boolean;
  overviewDashboard: boolean;
  calendar: boolean;
  messaging: boolean;
  backup: boolean;
  demoDatasetCreation: boolean;
}>;

export type AuthenticatedSupport = Readonly<{
  displayLabel: string;
  email: string | null;
  helpUrl: string | null;
}>;
