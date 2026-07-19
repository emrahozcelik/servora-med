import { Popconfirm } from 'antd';
import { useEffect, useRef, type ReactNode } from 'react';

export type CompactConfirmationActionProps = Readonly<{
  title: ReactNode;
  description?: ReactNode;
  triggerLabel: string;
  confirmLabel?: string;
  cancelLabel?: string;
  pending: boolean;
  disabled?: boolean;
  onConfirm: (trigger: HTMLButtonElement) => void;
}>;

/** Owned compact confirmation for short, reversible commands. */
export function CompactConfirmationAction({
  title,
  description,
  triggerLabel,
  confirmLabel = 'Onayla',
  cancelLabel = 'Vazgeç',
  pending,
  disabled = false,
  onConfirm,
}: CompactConfirmationActionProps): ReactNode {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const confirmRequestedRef = useRef(false);

  useEffect(() => {
    if (!pending) confirmRequestedRef.current = false;
  }, [pending]);

  function handleConfirm() {
    const trigger = triggerRef.current;
    if (!trigger || pending || confirmRequestedRef.current) return;
    confirmRequestedRef.current = true;
    onConfirm(trigger);
  }

  return (
    <Popconfirm
      title={title}
      description={description}
      okText={confirmLabel}
      cancelText={cancelLabel}
      disabled={disabled || pending}
      okButtonProps={{ disabled: pending, loading: pending }}
      cancelButtonProps={{ disabled: pending }}
      onConfirm={handleConfirm}
      onCancel={() => { confirmRequestedRef.current = false; }}
      onOpenChange={(open) => {
        if (open && !pending) confirmRequestedRef.current = false;
      }}
    >
      <button
        ref={triggerRef}
        className="secondary-button"
        type="button"
        disabled={disabled || pending}
      >
        {triggerLabel}
      </button>
    </Popconfirm>
  );
}
