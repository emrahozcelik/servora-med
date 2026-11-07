import {
  cloneElement, isValidElement, useEffect, useRef,
  type KeyboardEvent, type ReactElement,
} from 'react';
import { Pagination, type PaginationProps } from 'antd';
import {
  DEFAULT_LIST_PAGE_SIZE,
  listOffsetForPage,
  listPageCount,
  listPageNumber,
  listPageSize,
} from '../pagination';
import './servora-pagination.css';

/** Survives the loading remount so keyboard paging does not drop focus to body. */
const pendingPageFocus = new Map<string, number>();

/** Legacy low-level Ant adapter remains available for existing callers. */
export type ServoraPaginationProps = PaginationProps;

export function ServoraPagination(props: ServoraPaginationProps) {
  return <Pagination {...props} />;
}

export type ServoraListPaginationProps = Readonly<{
  total: number;
  offset: number;
  /** Overrides require a documented screen-specific exception. */
  pageSize?: number;
  label: string;
  itemName: string;
  disabled?: boolean;
  onOffsetChange: (offset: number) => void;
}>;

/** Controlled, compact pager; the surrounding screen owns API state and URL filters. */
export function ServoraListPagination({
  total, offset, pageSize = DEFAULT_LIST_PAGE_SIZE, label, itemName, disabled = false, onOffsetChange,
}: ServoraListPaginationProps) {
  const size = listPageSize(pageSize);
  const pageCount = listPageCount(total, size);
  const current = listPageNumber(offset, total, size);
  const navRef = useRef<HTMLElement>(null);
  const keyboardActivation = useRef(false);

  useEffect(() => {
    if (pendingPageFocus.get(label) !== current) return;
    pendingPageFocus.delete(label);
    navRef.current?.focus({ preventScroll: true });
  }, [current, label]);

  // Ant's simple pager leaves Next without a tabIndex on page 1. Restore the
  // native button semantics and a Turkish name on the focusable item.
  useEffect(() => {
    const nav = navRef.current;
    if (!nav || !Number.isSafeInteger(total) || total <= size) return;
    const prevDisabled = disabled || current <= 1;
    const nextDisabled = disabled || current >= pageCount;
    for (const [item, itemLabel, itemDisabled] of [
      [nav.querySelector<HTMLElement>('[class*="pagination-prev"]'), 'Önceki sayfa', prevDisabled],
      [nav.querySelector<HTMLElement>('[class*="pagination-next"]'), 'Sonraki sayfa', nextDisabled],
    ] as const) {
      if (!item) continue;
      item.tabIndex = itemDisabled ? -1 : 0;
      item.setAttribute('role', 'button');
      item.setAttribute('aria-label', itemLabel);
      item.setAttribute('aria-disabled', String(itemDisabled));
    }
  }, [current, disabled, pageCount, size, total]);

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Enter') {
      const enterTarget = event.target as HTMLElement;
      if (enterTarget.getAttribute('role') === 'button') keyboardActivation.current = true;
      return;
    }
    if (event.key !== ' ' && event.key !== 'Spacebar') return;
    const target = event.target as HTMLElement;
    if (target.getAttribute('role') !== 'button') return;
    event.preventDefault();
    keyboardActivation.current = true;
    target.click();
  }

  if (!Number.isSafeInteger(total) || total <= size) return null;
  return (
    <nav ref={navRef} tabIndex={-1} className="servora-list-pagination" aria-label={label} onKeyDownCapture={handleKeyDown}>
      <span className="servora-list-pagination__summary" aria-live="polite">
        Sayfa {current} / {listPageCount(total, size)} · Toplam {total} {itemName}
      </span>
      <ServoraPagination
        current={current}
        pageSize={size}
        total={total}
        disabled={disabled}
        simple={{ readOnly: true }}
        showSizeChanger={false}
        showQuickJumper={false}
        hideOnSinglePage
        size="small"
        itemRender={(_, type, element) => {
          if ((type === 'prev' || type === 'next') && isValidElement(element)) {
            return cloneElement(element as ReactElement<{ 'aria-label'?: string }>, {
              'aria-label': type === 'prev' ? 'Önceki sayfa' : 'Sonraki sayfa',
            });
          }
          return element;
        }}
        onChange={(page) => {
          if (keyboardActivation.current) pendingPageFocus.set(label, page);
          keyboardActivation.current = false;
          onOffsetChange(listOffsetForPage(page, total, size));
        }}
      />
    </nav>
  );
}
