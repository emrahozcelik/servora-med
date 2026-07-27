import { Tabs } from 'antd';
import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';

export type SettingsTab = {
  key: string;
  label: string;
  to: string;
};

export type SettingsTabsProps = {
  items: SettingsTab[];
  activeKey: string;
  ariaLabel?: string;
};

export function SettingsTabs({
  items,
  activeKey,
  ariaLabel,
}: SettingsTabsProps): ReactNode {
  const tabItems = items.map((item) => ({
    key: item.key,
    label: <Link to={item.to}>{item.label}</Link>,
  }));

  return (
    <Tabs
      className="servora-settings-tabs"
      items={tabItems}
      activeKey={activeKey}
      aria-label={ariaLabel}
    />
  );
}
