import { paths } from '../paths';

export type NewJobOptionKey = 'meeting' | 'task' | 'delivery' | 'sale' | 'weekly-report';

export type NewJobOption = {
  key: NewJobOptionKey;
  label: string;
  to: string;
};

/**
 * Single ordered source for the job-creation entries. `NewJobMenu` (toolbar,
 * desktop topbar, mobile sheet) and the desktop command palette both read it,
 * so a new create flow cannot appear on one surface and silently miss another.
 */
export const NEW_JOB_OPTIONS: readonly NewJobOption[] = [
  { key: 'meeting', label: 'Görüşme / ziyaret planla', to: paths.newMeeting },
  { key: 'task', label: 'Yeni görev', to: paths.newTask },
  { key: 'delivery', label: 'Yeni teslim', to: paths.newDelivery },
  { key: 'sale', label: 'Satış kaydı', to: paths.newStandaloneSale },
  { key: 'weekly-report', label: 'Haftalık Rapor', to: paths.newWeeklyReport },
];
