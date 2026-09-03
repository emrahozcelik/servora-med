import { Select } from 'antd';
import type { SelectProps } from 'antd';

import { getServoraPopupContainer } from './ServoraAntProvider';

export type ServoraSelectProps = SelectProps;

/**
 * Owned antd Select adapter. Feature code must not import 'antd' directly
 * (see tests/antd-boundary.test.ts); this adapter pins the application-wide
 * popup-container convention while forwarding all Select behavior.
 */
export function ServoraSelect({
  getPopupContainer = getServoraPopupContainer,
  ...props
}: ServoraSelectProps) {
  return <Select {...props} getPopupContainer={getPopupContainer} />;
}
