import { useEffect, useState, type RefObject } from 'react';

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
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) setPending(false);
  }, [open]);

  return (
    <ResponsiveFormDrawer
      open={open}
      title="Yeni müşteri"
      onDismiss={onCancel}
      returnFocusRef={returnFocusRef}
      rootClassName="job-customer-create-drawer"
      dismissDisabled={pending}
    >
      <CustomerCreateFlow
        user={user}
        embedded
        onCancel={onCancel}
        onCreated={onCreated}
        onPendingChange={setPending}
      />
    </ResponsiveFormDrawer>
  );
}
