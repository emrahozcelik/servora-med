import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useNavigate } from 'react-router-dom';

import { jobStatusLabels, jobTypeLabel } from '../jobs/job-labels';
import { listJobCards, type JobCardListItem } from '../jobs/jobs-api';
import { paths } from '../paths';
import type { CurrentUser } from '../services/api';
import {
  customerTypeLabels,
  listCustomers,
  type CustomerSummary,
} from '../services/crm-api';
import { NavigationIcon } from './navigation-icons';
import type { NavLinkItem } from './navigation-model';
import { canAccessRoute } from './route-access';

export type CommandPaletteProps = {
  user: CurrentUser;
  destinations: NavLinkItem[];
  onClose: (restoreFocus?: boolean) => void;
};

type PaletteEntry = {
  id: string;
  group: 'actions' | 'pages' | 'customers' | 'jobs';
  label: string;
  subtitle?: string;
  to: string;
};

const GROUP_LABELS: Record<PaletteEntry['group'], string> = {
  actions: 'Hızlı işlemler',
  pages: 'Sayfalar',
  customers: 'Müşteriler',
  jobs: 'İş kartları',
};

const REMOTE_QUERY_MIN_LENGTH = 2;
const REMOTE_SEARCH_DEBOUNCE_MS = 220;

function normalizeTr(value: string): string {
  return value.toLocaleLowerCase('tr-TR').trim();
}

function focusableInside(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'input:not([disabled]), button:not([disabled]), a[href]',
    ),
  );
}

/**
 * Global desktop Quick Search & Command Palette (`⌘K` / `Ctrl K`).
 * Reuses existing navigation model, role guards, `/api/customers`, and `/api/job-cards`
 * without introducing any new backend endpoints or client-only permissions.
 */
export function CommandPalette({ user, destinations, onClose }: CommandPaletteProps) {
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestIdRef = useRef(0);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [searching, setSearching] = useState(false);
  const [partialError, setPartialError] = useState(false);
  const [customers, setCustomers] = useState<CustomerSummary[]>([]);
  const [jobs, setJobs] = useState<JobCardListItem[]>([]);

  const trimmedQuery = query.trim();
  const normalizedQuery = normalizeTr(query);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function containFocus(event: FocusEvent) {
      if (dialog && event.target instanceof Node && !dialog.contains(event.target)) {
        inputRef.current?.focus();
      }
    }

    document.addEventListener('focusin', containFocus);
    return () => {
      document.removeEventListener('focusin', containFocus);
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    if (trimmedQuery.length < REMOTE_QUERY_MIN_LENGTH) {
      requestIdRef.current += 1;
      setSearching(false);
      setPartialError(false);
      setCustomers([]);
      setJobs([]);
      return;
    }

    const requestId = ++requestIdRef.current;
    setSearching(true);
    setPartialError(false);

    const timer = window.setTimeout(async () => {
      const [customerResult, jobResult] = await Promise.allSettled([
        listCustomers({ q: trimmedQuery, limit: 5 }),
        listJobCards({ q: trimmedQuery, limit: 5 }),
      ]);

      if (requestId !== requestIdRef.current) return;

      let hadFailure = false;
      if (customerResult.status === 'fulfilled') {
        setCustomers(customerResult.value.items);
      } else {
        setCustomers([]);
        hadFailure = true;
      }

      if (jobResult.status === 'fulfilled') {
        setJobs(jobResult.value.items);
      } else {
        setJobs([]);
        hadFailure = true;
      }

      setPartialError(hadFailure);
      setSearching(false);
    }, REMOTE_SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [trimmedQuery]);

  const quickActions = useMemo<PaletteEntry[]>(() => {
    const entries: PaletteEntry[] = [
      { id: 'action-new-meeting', group: 'actions', label: 'Görüşme / ziyaret planla', subtitle: 'Yeni iş kartı', to: paths.newMeeting },
      { id: 'action-new-task', group: 'actions', label: 'Yeni görev', subtitle: 'Yeni iş kartı', to: paths.newTask },
      { id: 'action-new-delivery', group: 'actions', label: 'Yeni teslim', subtitle: 'Yeni iş kartı', to: paths.newDelivery },
      { id: 'action-new-weekly-report', group: 'actions', label: 'Haftalık Rapor', subtitle: 'Yeni iş kartı', to: paths.newWeeklyReport },
    ];
    if (canAccessRoute('customerCreate', user)) {
      entries.push({
        id: 'action-new-customer',
        group: 'actions',
        label: 'Yeni müşteri',
        subtitle: 'Müşteriler',
        to: paths.newCustomer,
      });
    }
    return entries;
  }, [user]);

  const pageEntries = useMemo<PaletteEntry[]>(
    () => destinations.map((destination) => ({
      id: `page-${destination.id}`,
      group: 'pages',
      label: destination.label,
      subtitle: destination.section,
      to: destination.to,
    })),
    [destinations],
  );

  const filteredActions = useMemo(
    () => (normalizedQuery === ''
      ? quickActions
      : quickActions.filter((entry) => normalizeTr(`${entry.label} ${entry.subtitle ?? ''}`).includes(normalizedQuery))),
    [quickActions, normalizedQuery],
  );

  const filteredPages = useMemo(
    () => (normalizedQuery === ''
      ? pageEntries
      : pageEntries.filter((entry) => normalizeTr(`${entry.label} ${entry.subtitle ?? ''}`).includes(normalizedQuery))),
    [pageEntries, normalizedQuery],
  );

  const customerEntries = useMemo<PaletteEntry[]>(
    () => customers.map((customer) => {
      const locationParts = [customer.district, customer.city].filter(Boolean).join(', ');
      const typeLabel = customerTypeLabels[customer.customerType];
      return {
        id: `customer-${customer.id}`,
        group: 'customers',
        label: customer.name,
        subtitle: locationParts ? `${typeLabel} · ${locationParts}` : typeLabel,
        to: paths.customer(customer.id),
      };
    }),
    [customers],
  );

  const jobEntries = useMemo<PaletteEntry[]>(
    () => jobs.map((job) => {
      const parts = [
        job.customer?.name,
        jobTypeLabel(job.type),
        jobStatusLabels[job.status],
      ].filter(Boolean);
      return {
        id: `job-${job.id}`,
        group: 'jobs',
        label: job.title,
        subtitle: parts.join(' · '),
        to: paths.job(job.id),
      };
    }),
    [jobs],
  );

  const groupedEntries = useMemo(() => {
    const groups: Array<{ key: PaletteEntry['group']; items: PaletteEntry[] }> = [];
    if (trimmedQuery.length >= REMOTE_QUERY_MIN_LENGTH) {
      if (jobEntries.length > 0) groups.push({ key: 'jobs', items: jobEntries });
      if (customerEntries.length > 0) groups.push({ key: 'customers', items: customerEntries });
      if (filteredPages.length > 0) groups.push({ key: 'pages', items: filteredPages });
      if (filteredActions.length > 0) groups.push({ key: 'actions', items: filteredActions });
    } else {
      if (filteredActions.length > 0) groups.push({ key: 'actions', items: filteredActions });
      if (filteredPages.length > 0) groups.push({ key: 'pages', items: filteredPages });
    }
    return groups;
  }, [trimmedQuery, jobEntries, customerEntries, filteredPages, filteredActions]);

  const flatEntries = useMemo(
    () => groupedEntries.flatMap((group) => group.items),
    [groupedEntries],
  );

  const boundedActiveIndex = flatEntries.length === 0
    ? -1
    : Math.min(Math.max(activeIndex, 0), flatEntries.length - 1);

  const activeEntry = boundedActiveIndex >= 0 ? flatEntries[boundedActiveIndex] : undefined;

  useEffect(() => {
    setActiveIndex(0);
  }, [normalizedQuery, customers.length, jobs.length]);

  const activateEntry = useCallback((entry: PaletteEntry) => {
    onClose(false);
    navigate(entry.to);
  }, [navigate, onClose]);

  function handleDialogKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose(true);
      return;
    }
    if (event.key === 'ArrowDown') {
      if (flatEntries.length === 0) return;
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % flatEntries.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      if (flatEntries.length === 0) return;
      event.preventDefault();
      setActiveIndex((current) => (current - 1 + flatEntries.length) % flatEntries.length);
      return;
    }
    if (event.key === 'Enter' && document.activeElement === inputRef.current && activeEntry) {
      event.preventDefault();
      activateEntry(activeEntry);
      return;
    }
    if (event.key === 'Tab') {
      const focusable = focusableInside(event.currentTarget);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  let runningIndex = -1;

  return (
    <div
      className="command-palette-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose(true);
      }}
    >
      <div
        ref={dialogRef}
        className="command-palette-dialog surface-raised"
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-palette-title"
        onKeyDown={handleDialogKeyDown}
      >
        <h2 id="command-palette-title" className="sr-only">Hızlı arama</h2>

        <div className="command-palette-input-row">
          <NavigationIcon id="search" className="command-palette-search-icon" />
          <input
            ref={inputRef}
            type="search"
            className="command-palette-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Sayfa, müşteri veya iş kartı ara…"
            aria-label="Hızlı arama"
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls="command-palette-results"
            aria-activedescendant={activeEntry ? `command-palette-option-${activeEntry.id}` : undefined}
          />
          <button
            type="button"
            className="command-palette-close"
            onClick={() => onClose(true)}
          >
            Kapat
          </button>
        </div>

        <div
          id="command-palette-results"
          className="command-palette-results"
          role="listbox"
          aria-label="Arama sonuçları"
        >
          {searching && (
            <p className="command-palette-status" role="status">Aranıyor…</p>
          )}
          {partialError && !searching && (
            <p className="command-palette-status" role="status">Bazı arama sonuçları yüklenemedi.</p>
          )}

          {!searching && flatEntries.length === 0 ? (
            <p className="command-palette-empty">Sonuç bulunamadı</p>
          ) : (
            groupedEntries.map((group) => (
              <section key={group.key} className="command-palette-group" aria-label={GROUP_LABELS[group.key]}>
                <h3 className="command-palette-group-title">{GROUP_LABELS[group.key]}</h3>
                <ul className="command-palette-list">
                  {group.items.map((entry) => {
                    runningIndex += 1;
                    const entryIndex = runningIndex;
                    const selected = entryIndex === boundedActiveIndex;
                    return (
                      <li key={entry.id}>
                        <button
                          id={`command-palette-option-${entry.id}`}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          className="command-palette-option"
                          onMouseEnter={() => setActiveIndex(entryIndex)}
                          onClick={() => activateEntry(entry)}
                        >
                          <span className="command-palette-option-label">{entry.label}</span>
                          {entry.subtitle && (
                            <span className="command-palette-option-subtitle">{entry.subtitle}</span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}
        </div>

        <div className="command-palette-footer">
          <span>↑↓ Gezin · ↵ Aç · Esc Kapat</span>
          {trimmedQuery.length > 0 && trimmedQuery.length < REMOTE_QUERY_MIN_LENGTH && (
            <span>Müşteri ve iş aramak için en az 2 karakter yazın</span>
          )}
        </div>
      </div>
    </div>
  );
}
