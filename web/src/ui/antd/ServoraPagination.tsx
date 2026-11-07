import { cloneElement, isValidElement, type ReactElement } from 'react';
import { Pagination, type PaginationProps } from 'antd';
import {
  DEFAULT_LIST_PAGE_SIZE,
  listOffsetForPage,
  listPageCount,
  listPageNumber,
  listPageSize,
} from '../pagination';
import './servora-pagination.css';

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
  if (!Number.isSafeInteger(total) || total <= size) return null;
  const current = listPageNumber(offset, total, size);
  return (
    <nav className="servora-list-pagination" aria-label={label}>
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
        onChange={(page) => onOffsetChange(listOffsetForPage(page, total, size))}
      />
    </nav>
  );
}
