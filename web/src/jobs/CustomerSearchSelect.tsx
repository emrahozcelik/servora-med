import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type UIEvent } from 'react';

import { ApiError } from '../services/api';
import { getCustomer, listCustomers, type CustomerSummary } from '../services/crm-api';
import { createRequestGate } from '../services/request-gate';
import { ServoraSelect } from '../ui/antd';

/** Bounded remote page: the selector never loads the full customer catalog. */
export const CUSTOMER_SEARCH_PAGE_SIZE = 20;
/** Modest debounce so typing does not send a request per keystroke. */
export const CUSTOMER_SEARCH_DEBOUNCE_MS = 300;

export type CustomerSearchSelectProps = {
  id: string;
  /** Selected customer id; empty string means no selection. */
  value: string;
  onChange: (customerId: string) => void;
  /** Fires with the resolved summary on initial resolve, user select, clear and explicit pin. */
  onCustomerResolved?: (customer: CustomerSummary | null) => void;
  /** Newly created (or otherwise externally known) customer to pin without a catalog fetch. */
  pinnedCustomer?: CustomerSummary | null;
  /** Reports whether the selector finished its initial load (gates form submit). */
  onReadyChange?: (ready: boolean) => void;
  /**
   * When a directly-resolved id (initial value, never a user pick) no longer
   * exists on the server, clear the value instead of keeping a stale id.
   * Preserves the previous full-list flows that dropped unknown initials.
   */
  clearValueWhenMissing?: boolean;
  /**
   * Applies to direct resolution only; remote results always follow the
   * server contract. When the resolved customer is ineligible, the value is
   * cleared the same way as a missing one.
   */
  isEligible?: (customer: CustomerSummary) => boolean;
  disabled?: boolean;
  placeholder?: string;
  invalid?: boolean;
  describedBy?: string;
  allowClear?: boolean;
};

function optionMeta(customer: CustomerSummary) {
  return [customer.city, customer.phone].filter((part) => part && part.trim()).join(' · ');
}

function renderLabel(customer: CustomerSummary): ReactNode {
  const meta = optionMeta(customer);
  return (
    <span className="customer-option-label">
      <span>{customer.name}</span>
      {meta && <span className="customer-option-meta"> · {meta}</span>}
    </span>
  );
}

function dedupeById(items: CustomerSummary[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

export function CustomerSearchSelect({
  id,
  value,
  onChange,
  onCustomerResolved,
  pinnedCustomer,
  onReadyChange,
  clearValueWhenMissing,
  isEligible,
  disabled,
  placeholder = 'Müşteri ara',
  invalid,
  describedBy,
  allowClear,
}: CustomerSearchSelectProps) {
  const [searchText, setSearchText] = useState('');
  const [committedQuery, setCommittedQuery] = useState('');
  const [results, setResults] = useState<CustomerSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [pinned, setPinned] = useState<CustomerSummary | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [initialState, setInitialState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [resolveAttempt, setResolveAttempt] = useState(0);
  const searchGate = useRef(createRequestGate());
  const resolveGate = useRef(createRequestGate());
  const loadedQueryRef = useRef<string | null>(null);
  const pinnedRef = useRef<CustomerSummary | null>(null);
  pinnedRef.current = pinned;
  // Snapshot for async continuations: render-scope state in a stale closure
  // must never downgrade a selection that arrived while a page was in flight.
  const statusRef = useRef({ hasPinned: false, resultCount: 0, value: '' });
  statusRef.current = { hasPinned: pinned !== null, resultCount: results.length, value };
  const onCustomerResolvedRef = useRef(onCustomerResolved);
  onCustomerResolvedRef.current = onCustomerResolved;
  const onReadyChangeRef = useRef(onReadyChange);
  onReadyChangeRef.current = onReadyChange;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const clearValueWhenMissingRef = useRef(clearValueWhenMissing);
  clearValueWhenMissingRef.current = clearValueWhenMissing;
  const isEligibleRef = useRef(isEligible);
  isEligibleRef.current = isEligible;

  useEffect(() => {
    const search = searchGate.current;
    const resolve = resolveGate.current;
    return () => { search.next(); resolve.next(); };
  }, []);

  useEffect(() => {
    onReadyChangeRef.current?.(initialState === 'ready');
  }, [initialState]);

  // Resolve the selected label directly: never fetch the catalog for it.
  useEffect(() => {
    if (!value) {
      resolveGate.current.next();
      setPinned((current) => {
        if (current !== null) onCustomerResolvedRef.current?.(null);
        return null;
      });
      setInitialState((current) => (current === 'loading' ? 'ready' : current));
      return;
    }
    // The id is already known locally (just picked from results or pinned):
    // resolving it again would waste a request and could clobber fresh state.
    if (pinnedRef.current?.id === value) {
      setInitialState('ready');
      return;
    }
    if (pinnedCustomer && pinnedCustomer.id === value) {
      resolveGate.current.next();
      setPinned(pinnedCustomer);
      onCustomerResolvedRef.current?.(pinnedCustomer);
      setInitialState('ready');
      return;
    }
    const generation = resolveGate.current.next();
    let cancelled = false;
    void getCustomer(value).then((detail) => {
      if (cancelled || !resolveGate.current.isCurrent(generation)) return;
      if (isEligibleRef.current && !isEligibleRef.current(detail)) {
        if (cancelled || !resolveGate.current.isCurrent(generation)) return;
        setPinned(null);
        onCustomerResolvedRef.current?.(null);
        if (clearValueWhenMissingRef.current) {
          onChangeRef.current('');
          setInitialState('ready');
        } else {
          setInitialState('error');
        }
        return;
      }
      setPinned(detail);
      onCustomerResolvedRef.current?.(detail);
      setInitialState('ready');
    }).catch((caught) => {
      if (cancelled || !resolveGate.current.isCurrent(generation)) return;
      if (clearValueWhenMissingRef.current && caught instanceof ApiError && caught.status === 404) {
        setPinned(null);
        onCustomerResolvedRef.current?.(null);
        onChangeRef.current('');
        setInitialState('ready');
        return;
      }
      setInitialState('error');
    });
    return () => { cancelled = true; };
    // Intentionally keyed on the identity only: option merges must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, pinnedCustomer?.id, resolveAttempt]);

  // Debounce typing; the input itself stays responsive.
  useEffect(() => {
    const timer = setTimeout(() => setCommittedQuery(searchText.trim()), CUSTOMER_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchText]);

  async function fetchPage(query: string, offset: number, mode: 'replace' | 'append') {
    const generation = searchGate.current.next();
    if (mode === 'replace') setPageLoading(true);
    else setLoadingMore(true);
    setLoadError(null);
    try {
      const page = await listCustomers({
        q: query === '' ? undefined : query,
        limit: CUSTOMER_SEARCH_PAGE_SIZE,
        offset,
      });
      if (!searchGate.current.isCurrent(generation)) return;
      setResults((current) => (mode === 'append' ? dedupeById([...current, ...page.items]) : page.items));
      setTotal(page.total);
      loadedQueryRef.current = query;
      setInitialState('ready');
    } catch {
      if (!searchGate.current.isCurrent(generation)) return;
      // A failed search never clears results or the valid selection.
      setLoadError(query === ''
        ? 'Müşteriler yüklenemedi.'
        : 'Arama sırasında bir sorun oluştu.');
      const status = statusRef.current;
      if (!status.hasPinned && status.resultCount === 0 && status.value === '') {
        setInitialState('error');
      }
    } finally {
      if (searchGate.current.isCurrent(generation)) {
        setPageLoading(false);
        setLoadingMore(false);
      }
    }
    // State reads above are intentionally snapshot-based; generations guard races.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }

  function ensurePage(query: string) {
    if (loadedQueryRef.current === query && !loadError) return;
    void fetchPage(query, 0, 'replace');
  }

  // Bounded first page on mount plus refetch on debounced query change.
  // The initial load also drives parent submit gating via onReadyChange.
  useEffect(() => {
    ensurePage(committedQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committedQuery]);

  function handleOpenChange(visible: boolean) {
    if (visible) {
      ensurePage(committedQuery);
    } else {
      // Reset the ad-hoc query so reopening shows the default first page.
      if (searchText !== '') setSearchText('');
      if (committedQuery !== '') setCommittedQuery('');
      loadedQueryRef.current = null;
    }
  }

  function handlePopupScroll(event: UIEvent<HTMLDivElement>) {
    const target = event.currentTarget;
    const nearBottom = target.scrollTop + target.clientHeight >= target.scrollHeight - 80;
    if (!nearBottom || pageLoading || loadingMore) return;
    if (results.length >= total) return;
    void fetchPage(committedQuery, results.length, 'append');
  }

  function handleChange(next: string) {
    const nextValue = next ?? '';
    setSearchText('');
    setCommittedQuery('');
    loadedQueryRef.current = null;
    const selected = nextValue === ''
      ? null
      : results.find((item) => item.id === nextValue)
        ?? (pinned && pinned.id === nextValue ? pinned : null);
    if (nextValue === '') {
      setPinned(null);
    } else if (selected) {
      setPinned(selected);
    }
    // onChange first so parents reset derived state (e.g. Delivery's
    // manual-assignee flag) before the resolved summary is applied.
    onChange(nextValue);
    onCustomerResolvedRef.current?.(selected);
  }

  function handleRetry(event: ReactMouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (initialState === 'error' && !pinned && results.length === 0 && value) {
      setInitialState('loading');
      setResolveAttempt((attempt) => attempt + 1);
      return;
    }
    if (initialState === 'error') {
      setInitialState('loading');
    }
    void fetchPage(committedQuery, 0, 'replace');
  }

  const visibleOptions = (pinned && !results.some((item) => item.id === pinned.id)
    ? [pinned, ...results]
    : results
  ).map((item) => ({ value: item.id, label: renderLabel(item) }));
  const hasMore = results.length < total;

  let notFoundContent: ReactNode;
  if (pageLoading && visibleOptions.length === 0) {
    notFoundContent = 'Aranıyor…';
  } else if (loadError && visibleOptions.length === 0) {
    notFoundContent = (
      <span className="customer-search-empty">
        {loadError}{' '}
        <button type="button" className="inline-action" onMouseDown={(event) => event.preventDefault()} onClick={handleRetry}>
          Tekrar dene
        </button>
      </span>
    );
  } else if (committedQuery !== '') {
    notFoundContent = 'Sonuç bulunamadı';
  } else {
    notFoundContent = 'Müşteri bulunamadı';
  }

  return (
    <>
      <ServoraSelect
        id={id}
        showSearch
        filterOption={false}
        autoClearSearchValue={false}
        searchValue={searchText}
        onSearch={setSearchText}
        value={value === '' ? undefined : value}
        onChange={handleChange}
        options={visibleOptions}
        loading={pageLoading || loadingMore}
        disabled={disabled}
        placeholder={placeholder}
        allowClear={allowClear}
        status={invalid ? 'error' : undefined}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        notFoundContent={notFoundContent}
        onOpenChange={handleOpenChange}
        onPopupScroll={handlePopupScroll}
        popupRender={(menu) => (
          <>
            {menu}
            {hasMore && !pageLoading && (
              <div className="customer-search-more" role="status">
                {loadingMore ? 'Daha fazla müşteri yükleniyor…' : `${total - results.length} sonuç daha var — kaydırın`}
              </div>
            )}
          </>
        )}
      />
      {initialState === 'loading' && !pinned && (
        <span className="field-status" role="status">Müşteriler yükleniyor…</span>
      )}
      {initialState === 'error' && !pinned && (
        <span className="field-error" role="alert">
          Müşteriler yüklenemedi.{' '}
          <button type="button" className="inline-action" onClick={handleRetry}>Tekrar dene</button>
        </span>
      )}
      {loadError && (pinned || results.length > 0) && (
        <span className="field-error" role="alert">
          {loadError}{' '}
          <button type="button" className="inline-action" onClick={handleRetry}>Tekrar dene</button>
        </span>
      )}
    </>
  );
}
