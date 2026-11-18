import { Select } from 'antd';
import type { SelectProps } from 'antd';
import type { ComponentRef, Ref } from 'react';

import { getServoraPopupContainer } from './ServoraAntProvider';

export type ServoraSelectProps = SelectProps & { ref?: Ref<ComponentRef<typeof Select>> };

/**
 * Owned antd Select adapter. Feature code must not import 'antd' directly
 * (see tests/antd-boundary.test.ts); this adapter pins the application-wide
 * popup-container convention and the owned `servora-select` focus class while
 * forwarding all Select behavior.
 */
export function ServoraSelect({
  getPopupContainer = getServoraPopupContainer,
  className,
  ...props
}: ServoraSelectProps) {
  // `servora-select` is the owned hook for the shared focus outline (F-02).
  return (
    <Select
      {...props}
      className={className ? `servora-select ${className}` : 'servora-select'}
      getPopupContainer={getPopupContainer}
    />
  );
}
