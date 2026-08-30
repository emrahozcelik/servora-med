export type DataManagementCount = Readonly<{
  total: number;
  active: number;
  inactive: number;
}>;

export type CustomerDataManagementCount = DataManagementCount & Readonly<{
  prospect: number;
}>;

export type DemoDatasetDataManagementCount = Readonly<{
  total: number;
  active: number;
}>;

export type DataManagementSummary = Readonly<{
  customers: CustomerDataManagementCount;
  contacts: DataManagementCount;
  products: DataManagementCount;
  staff: DataManagementCount;
  demoDataset: DemoDatasetDataManagementCount;
}>;
