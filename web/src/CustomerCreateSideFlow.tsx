import type { RefObject } from 'react';

import { CustomerCreateFlow } from './CustomerList';
import type { Customer } from './services/crm-api';
import { ResponsiveFormDrawer } from './ui/antd';
import type { CurrentUser } from './services/api';

export function CustomerCreateSideFlow({
  open,
  user,
  returnFocusRef,
  onCancel,
  onCreated,
}: {
  open: boolean;
  user: CurrentUser;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onCancel: () => void;
  onCreated: (customer: Customer) => void;
}) {
  return (
    <ResponsiveFormDrawer
      open={open}
      title="Yeni müşteri"
      onDismiss={onCancel}
      returnFocusRef={returnFocusRef}
      rootClassName="job-customer-create-drawer"
    >
      <CustomerCreateFlow
        user={user}
        embedded
        onCancel={onCancel}
        onCreated={onCreated}
      />
    </ResponsiveFormDrawer>
  );
}
