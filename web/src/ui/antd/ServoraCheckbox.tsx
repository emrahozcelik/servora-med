import { Checkbox } from 'antd';
import type { CheckboxChangeEvent } from 'antd/es/checkbox';
import type { ReactNode } from 'react';

export type ServoraCheckboxProps = {
  id?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
};

/**
 * Owned antd Checkbox adapter. Feature code must not import 'antd' directly
 * (see tests/antd-boundary.test.ts); this adapter forwards Checkbox behavior
 * with the controlled checked/onChange contract used by Servora filters.
 */
export function ServoraCheckbox({ id, checked, onChange, children }: ServoraCheckboxProps): ReactNode {
  return (
    <Checkbox
      id={id}
      checked={checked}
      onChange={(event: CheckboxChangeEvent) => onChange(event.target.checked)}
    >
      {children}
    </Checkbox>
  );
}
