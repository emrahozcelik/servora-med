export type AuthenticatedCapabilities = Readonly<{
  overviewDashboard: boolean;
  calendar: boolean;
  messaging: boolean;
}>;

export type AuthenticatedSupport = Readonly<{
  displayLabel: string;
  email: string | null;
  helpUrl: string | null;
}>;
