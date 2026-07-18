import { App as AntApp } from 'antd';

export type AppFeedback = ReturnType<typeof AntApp.useApp>;

export function useAppFeedback(): AppFeedback {
  return AntApp.useApp();
}
