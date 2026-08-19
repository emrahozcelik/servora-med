import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError, type CurrentUser } from '../services/api';
import {
  archiveConversation,
  createOrGetConversation,
  getUnreadCount,
  listConversations,
  listMessages,
  listRecipients,
  markRead,
  sendMessage,
  unarchiveConversation,
  type Conversation,
  type ConversationListView,
  type Message,
  type Recipient,
} from '../services/messaging-api';
import { listJobCards } from '../jobs/jobs-api';
import { listCustomers } from '../services/crm-api';
import { jobCardStatusLabel } from '../jobs/job-labels';
import { useRealtimeInvalidation } from '../realtime/RealtimeProvider';
import { LoadConversations, LoadMessages, LoadRecipients } from './MessagingSkeleton';
import { EmptyState } from '../ui/antd/EmptyState';
import { ResultState } from '../ui/antd/ResultState';
import { UserAvatar } from '../ui/antd/UserAvatar';
import './messaging.css';

type ListState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded' };

type DraftState = {
  body: string;
  clientActionId: string;
  status: 'pending' | 'sending' | 'error';
  error?: string;
} | null;

type ScrollMode = 'bottom' | 'preserve' | 'none';

type OlderRequest = {
  gen: number;
  convId: string;
  cursor: string;
};

type CreateContext = 'JOB' | 'CUSTOMER' | 'GENERAL';

type JobOption = {
  id: string;
  title: string;
  customerName: string | null;
  status: string;
  assigneeId: string;
  assigneeName: string;
};

type CustomerOption = {
  id: string;
  name: string;
};

type CreateErrors = Partial<Record<'job' | 'customer' | 'title' | 'participants', string>>;

const CONTEXT_LABELS: Record<CreateContext, string> = {
  JOB: 'İş',
  CUSTOMER: 'Müşteri',
  GENERAL: 'Genel konu',
};

function formatActivityTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  if (diff < 60_000) return 'Az önce';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} dk`;
  if (diff < 86_400_000) {
    return date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  }
  if (diff < 7 * 86_400_000) {
    return date.toLocaleDateString('tr-TR', { weekday: 'short' });
  }
  return date.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
}

function formatMessageTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('tr-TR', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Context-first participant summary. Newer contexts carry the full
 * participants collection; legacy rows fall back to participantName.
 */
function participantSummary(conversation: Conversation, selfId: string): string {
  const others = (conversation.participants ?? []).filter((p) => p.userId !== selfId);
  if (others.length === 0) return conversation.participantName || '';
  if (others.length === 1) return others[0].name;
  if (others.length === 2) return `${others[0].name}, ${others[1].name}`;
  return `${others[0].name} + ${others.length - 1} kişi`;
}

function firstOtherParticipant(conversation: Conversation, selfId: string): string {
  const others = (conversation.participants ?? []).filter((p) => p.userId !== selfId);
  return others[0]?.name ?? conversation.participantName;
}

function createErrorText(errors: CreateErrors): string | null {
  const first = errors.job ?? errors.customer ?? errors.title ?? errors.participants;
  return first ?? null;
}

let clientActionCounter = 0;
function nextClientActionId(userId: string): string {
  return `msg-${userId}-${Date.now()}-${++clientActionCounter}`;
}

export function MessagingPage({ user }: { user: CurrentUser }) {
  const [searchParams] = useSearchParams();
  const [listState, setListState] = useState<ListState>({ kind: 'loading' });
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationView, setConversationView] = useState<ConversationListView>('active');
  const [archivePendingId, setArchivePendingId] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageLoading, setMessageLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [composerText, setComposerText] = useState('');
  const [draft, setDraft] = useState<DraftState>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [unreadTotal, setUnreadTotal] = useState(0);
  const [markReadError, setMarkReadError] = useState<string | null>(null);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [olderLoading, setOlderLoading] = useState(false);

  // Context-first creation flow state
  const canCreate = user.role === 'ADMIN' || user.role === 'MANAGER';
  const [createOpen, setCreateOpen] = useState(false);
  const [createContext, setCreateContext] = useState<CreateContext>('JOB');
  const [jobQuery, setJobQuery] = useState('');
  const [jobs, setJobs] = useState<JobOption[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<JobOption | null>(null);
  const [customerQuery, setCustomerQuery] = useState('');
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [customersLoading, setCustomersLoading] = useState(false);
  const [customersError, setCustomersError] = useState<string | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerOption | null>(null);
  const [createTitle, setCreateTitle] = useState('');
  const [createParticipants, setCreateParticipants] = useState<Recipient[]>([]);
  const [createParticipantsLoading, setCreateParticipantsLoading] = useState(false);
  const [createParticipantsError, setCreateParticipantsError] = useState<string | null>(null);
  const [selectedParticipantIds, setSelectedParticipantIds] = useState<string[]>([]);
  const [createErrors, setCreateErrors] = useState<CreateErrors>({});
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createFlowError, setCreateFlowError] = useState<string | null>(null);
  const createFlowRef = useRef<HTMLDivElement>(null);
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const jobSearchRef = useRef<HTMLInputElement>(null);
  const customerSearchRef = useRef<HTMLInputElement>(null);
  const jobQuerySeqRef = useRef(0);
  const customerQuerySeqRef = useRef(0);
  const createParticipantsSeqRef = useRef(0);

  const threadEndRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const loadedPageRef = useRef<Message[]>([]);
  const scrollModeRef = useRef<ScrollMode>('bottom');
  const scrollRestoreRef = useRef({ prevHeight: 0, prevTop: 0 });
  const olderGenRef = useRef(0);
  const loadGenRef = useRef(0);
  const markReadGenRef = useRef(0);
  const olderActiveConvRef = useRef<string | null>(null);
  const pendingOlderRef = useRef<OlderRequest | null>(null);
  const pendingLoadRef = useRef<{ gen: number; convId: string } | null>(null);
  const pendingMarkReadRef = useRef<{ gen: number; convId: string } | null>(null);
  const listLoadGenRef = useRef(0);
  const activeViewButtonRef = useRef<HTMLButtonElement>(null);
  const archivedViewButtonRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const threadMessagesRef = useRef<HTMLDivElement>(null);

  // Centralized conversation transition — invalidates all pending requests
  const invalidateThread = useCallback(() => {
    loadGenRef.current++;
    olderGenRef.current++;
    markReadGenRef.current++;
    pendingLoadRef.current = null;
    pendingOlderRef.current = null;
    pendingMarkReadRef.current = null;
    olderActiveConvRef.current = null;
    setMessageLoading(false);
    setOlderLoading(false);
    setThreadError(null);
    setMarkReadError(null);
    setMessages([]);
    setOlderCursor(null);
    loadedPageRef.current = [];
    scrollModeRef.current = 'bottom';
  }, []);

  // --- Data loading ---

  const loadConversations = useCallback(async (view: ConversationListView = conversationView) => {
    const gen = ++listLoadGenRef.current;
    try {
      const page = await listConversations(view);
      if (listLoadGenRef.current !== gen) return;
      setConversations(page.items);
      setListState({ kind: 'loaded' });
    } catch (error) {
      if (listLoadGenRef.current !== gen) return;
      setListState({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Konuşmalar yüklenemedi.',
      });
    }
  }, [conversationView]);

  const loadUnreadCount = useCallback(async () => {
    try { setUnreadTotal(await getUnreadCount()); } catch { /* non-critical */ }
  }, []);

  const refresh = useCallback(async () => {
    setListState({ kind: 'loading' });
    await Promise.all([loadConversations(), loadUnreadCount()]);
  }, [loadConversations, loadUnreadCount]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Drill-down detection for 200% font-size
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => {
      const workspace = container.closest('.messaging-workspace');
      if (!workspace) return;
      workspace.classList.toggle('messaging-stacked', container.clientWidth < 650);
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [listState.kind]);

  // --- Realtime ---

  useRealtimeInvalidation(['conversations', 'message-unread'], () => {
    loadConversations();
    loadUnreadCount();
    setMarkReadError(null);
  });

  useRealtimeInvalidation(
    selectedId ? [`conversation:${selectedId}`] : [],
    () => {
      if (selectedId) {
        invalidateThread();
        setSelectedId(selectedId); // keep same conversation
        scrollModeRef.current = 'bottom';
        loadMessages(selectedId);
      }
      loadConversations();
      loadUnreadCount();
    },
  );

  // --- Messages + Pagination ---

  const loadMessages = useCallback(async (conversationId: string, cursor?: string | null): Promise<Message[]> => {
    const gen = ++loadGenRef.current;
    pendingLoadRef.current = { gen, convId: conversationId };
    setMessageLoading(true);
    setThreadError(null);
    try {
      const page = await listMessages(conversationId, cursor);
      // Validate: still same conversation and no newer load superseded this
      if (pendingLoadRef.current?.gen !== gen || pendingLoadRef.current?.convId !== conversationId) {
        return [];
      }
      setMessages(page.items);
      setOlderCursor(page.nextCursor);
      loadedPageRef.current = page.items;
      return page.items;
    } catch (error) {
      if (pendingLoadRef.current?.gen === gen && pendingLoadRef.current?.convId === conversationId) {
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
          // M9: membership was revoked (e.g. removed from the conversation).
          // Leave the thread; the server remains authoritative.
          setSelectedId(null);
          setThreadError(null);
          setMessages([]);
        } else {
          setThreadError(error instanceof Error ? error.message : 'Mesajlar yüklenemedi.');
        }
      }
      return [];
    } finally {
      if (pendingLoadRef.current?.gen === gen) {
        pendingLoadRef.current = null;
      }
      // Only clear loading if this is the current request
      if (pendingLoadRef.current === null || pendingLoadRef.current.gen <= gen) {
        setMessageLoading(false);
      }
    }
  }, []);

  // --- Older-page load with conversation-scoped invalidation ---

  const handleLoadOlder = useCallback(async () => {
    if (!selectedId || !olderCursor || olderLoading) return;

    const gen = ++olderGenRef.current;
    const request: OlderRequest = { gen, convId: selectedId, cursor: olderCursor };
    pendingOlderRef.current = request;
    olderActiveConvRef.current = selectedId;

    const log = threadMessagesRef.current;
    const prevHeight = log?.scrollHeight ?? 0;
    const prevTop = log?.scrollTop ?? 0;

    // Set mode BEFORE any state update
    scrollModeRef.current = 'none';
    setOlderLoading(true);

    try {
      const page = await listMessages(selectedId, olderCursor);

      // Validate request is still current before applying result
      if (
        pendingOlderRef.current?.gen !== gen ||
        pendingOlderRef.current?.convId !== selectedId ||
        pendingOlderRef.current?.cursor !== olderCursor
      ) {
        return; // Superseded by conversation switch, realtime, or new request
      }

      setMessages((prev) => [...page.items, ...prev]);
      setOlderCursor(page.nextCursor);

      // Use scroll restoration via useLayoutEffect
      scrollModeRef.current = 'preserve';
      scrollRestoreRef.current = { prevHeight, prevTop };
    } catch (error) {
      if (pendingOlderRef.current?.gen === gen && pendingOlderRef.current?.convId === selectedId) {
        setThreadError(error instanceof Error ? error.message : 'Eski mesajlar yüklenemedi.');
      }
    } finally {
      if (pendingOlderRef.current?.gen === gen) {
        pendingOlderRef.current = null;
      }
      // Only clear olderLoading if no newer request superseded this
      if (olderGenRef.current === gen) {
        setOlderLoading(false);
      }
    }
  }, [selectedId, olderCursor, olderLoading]);

  // --- Scroll state machine (useLayoutEffect for synchronous restore before paint) ---

  useLayoutEffect(() => {
    const log = threadMessagesRef.current;
    if (!log || messages.length === 0) return;

    const mode = scrollModeRef.current;

    if (mode === 'preserve') {
      const { prevHeight, prevTop } = scrollRestoreRef.current;
      const newHeight = log.scrollHeight;
      log.scrollTop = prevTop + (newHeight - prevHeight);
      scrollModeRef.current = 'none'; // consumed
    } else if (mode === 'bottom') {
      if (threadEndRef.current) {
        threadEndRef.current.scrollIntoView({ behavior: 'smooth' });
      }
      scrollModeRef.current = 'none';
    }
    // 'none' = no action
  }, [messages]);

  // --- Conversation selection ---

  const selectConversation = useCallback(
    async (conversation: Conversation) => {
      invalidateThread();
      setSelectedId(conversation.id);
      setDraft(null);
      setSendError(null);
      scrollModeRef.current = 'bottom';

      const gen = ++markReadGenRef.current;
      const markReq: { gen: number; convId: string } = { gen, convId: conversation.id };
      pendingMarkReadRef.current = markReq;

      const loadedMessages = await loadMessages(conversation.id);

      // Only mark-read if conversation hasn't changed and this request is still current
      if (pendingMarkReadRef.current?.gen === gen && conversation.unreadCount > 0 && loadedMessages.length > 0) {
        const lastOtherMsg = [...loadedMessages].reverse().find((m) => m.senderUserId !== user.id);
        if (lastOtherMsg) {
          try {
            await markRead(conversation.id, lastOtherMsg.id);
            if (pendingMarkReadRef.current?.gen === gen) {
              setMarkReadError(null);
            }
          } catch (error) {
            if (pendingMarkReadRef.current?.gen === gen) {
              setMarkReadError(error instanceof Error ? error.message : 'Okundu işaretlenemedi.');
            }
          }
        }
        loadConversations();
        loadUnreadCount();
      }
      if (pendingMarkReadRef.current?.gen === gen) {
        pendingMarkReadRef.current = null;
      }
    },
    [loadMessages, user.id, loadConversations, loadUnreadCount, invalidateThread],
  );

  const retryMarkRead = useCallback(async () => {
    if (!selectedId) return;
    const loadedMessages = loadedPageRef.current;
    if (loadedMessages.length === 0) return;
    const lastOtherMsg = [...loadedMessages].reverse().find((m) => m.senderUserId !== user.id);
    if (!lastOtherMsg) return;

    const gen = ++markReadGenRef.current;
    const req = { gen, convId: selectedId };
    pendingMarkReadRef.current = req;

    try {
      await markRead(selectedId, lastOtherMsg.id);
      if (pendingMarkReadRef.current?.gen === gen) {
        setMarkReadError(null);
      }
      loadConversations();
      loadUnreadCount();
    } catch (error) {
      if (pendingMarkReadRef.current?.gen === gen) {
        setMarkReadError(error instanceof Error ? error.message : 'Okundu işaretlenemedi.');
      }
    }
    if (pendingMarkReadRef.current?.gen === gen) {
      pendingMarkReadRef.current = null;
    }
  }, [selectedId, loadConversations, loadUnreadCount, user.id]);

  const focusConversationView = useCallback(() => {
    window.setTimeout(() => {
      const button = conversationView === 'active'
        ? activeViewButtonRef.current
        : archivedViewButtonRef.current;
      button?.focus();
    }, 0);
  }, [conversationView]);

  const switchConversationView = useCallback((view: ConversationListView) => {
    if (view === conversationView) return;
    invalidateThread();
    setSelectedId(null);
    setArchiveError(null);
    setConversationView(view);
  }, [conversationView, invalidateThread]);

  const handleConversationArchive = useCallback(async (conversation: Conversation, restoreFocus?: HTMLElement | null) => {
    if (conversation.unreadCount > 0 || archivePendingId) return;
    setArchivePendingId(conversation.id);
    setArchiveError(null);
    try {
      await archiveConversation(conversation.id);
      if (selectedId === conversation.id) {
        invalidateThread();
        setSelectedId(null);
      }
      await loadConversations();
      focusConversationView();
    } catch (error) {
      setArchiveError(error instanceof Error ? error.message : 'Konuşma arşivlenemedi.');
      restoreFocus?.focus();
    } finally {
      setArchivePendingId(null);
    }
  }, [archivePendingId, focusConversationView, invalidateThread, loadConversations, selectedId]);

  const handleConversationUnarchive = useCallback(async (conversation: Conversation, restoreFocus?: HTMLElement | null) => {
    if (archivePendingId) return;
    setArchivePendingId(conversation.id);
    setArchiveError(null);
    try {
      await unarchiveConversation(conversation.id);
      if (selectedId === conversation.id) {
        invalidateThread();
        setSelectedId(null);
      }
      await loadConversations();
      focusConversationView();
    } catch (error) {
      setArchiveError(error instanceof Error ? error.message : 'Konuşma arşivden çıkarılamadı.');
      restoreFocus?.focus();
    } finally {
      setArchivePendingId(null);
    }
  }, [archivePendingId, focusConversationView, invalidateThread, loadConversations, selectedId]);

  // Deep-link from notification center
  useEffect(() => {
    const convId = searchParams.get('conversation');
    if (convId && listState.kind === 'loaded') {
      const conv = conversations.find((c) => c.id === convId);
      if (conv) selectConversation(conv);
    }
  }, [listState.kind, conversations, searchParams, selectConversation]);

  // Cleanup on unmount
  useEffect(() => () => { invalidateThread(); }, [invalidateThread]);

  // --- Send ---

  const handleSend = useCallback(
    async (e?: React.KeyboardEvent) => {
      if (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
        } else if (e.key !== 'Enter') return;
        if (e.shiftKey && e.key === 'Enter') return;
      }

      const text = composerText.trim();
      if (!text || !selectedId) return;

      const effectiveActionId = draft?.body === text ? draft.clientActionId : nextClientActionId(user.id);
      setDraft({ body: text, clientActionId: effectiveActionId, status: 'sending' });
      setSendError(null);
      scrollModeRef.current = 'bottom';

      try {
        const msg = await sendMessage(selectedId, text, effectiveActionId);
        if (!msg.isDuplicate) setMessages((prev) => [...prev, msg]);
        setComposerText('');
        setDraft(null);
        loadConversations();
        loadUnreadCount();
      } catch (error) {
        setDraft({ body: text, clientActionId: effectiveActionId, status: 'error', error: error instanceof Error ? error.message : 'Gönderilemedi.' });
        setSendError(error instanceof Error ? error.message : 'Mesaj gönderilemedi.');
      }
    },
    [composerText, selectedId, user.id, draft, loadConversations, loadUnreadCount],
  );

  // --- Context-first creation flow ---

  const loadJobs = useCallback(async (query: string) => {
    const seq = ++jobQuerySeqRef.current;
    setJobsLoading(true);
    setJobsError(null);
    try {
      const page = await listJobCards({ status: 'active', q: query || undefined, limit: 50 });
      if (jobQuerySeqRef.current !== seq) return;
      setJobs(
        page.items.map((job) => ({
          id: job.id,
          title: job.title,
          customerName: job.customer?.name ?? null,
          status: job.status,
          assigneeId: job.assignee.id,
          assigneeName: job.assignee.name,
        })),
      );
    } catch (error) {
      if (jobQuerySeqRef.current !== seq) return;
      setJobsError(error instanceof Error ? error.message : 'İşler yüklenemedi.');
    } finally {
      if (jobQuerySeqRef.current === seq) setJobsLoading(false);
    }
  }, []);

  const loadCustomers = useCallback(async (query: string) => {
    const seq = ++customerQuerySeqRef.current;
    setCustomersLoading(true);
    setCustomersError(null);
    try {
      const page = await listCustomers({ q: query || undefined, limit: 50 });
      if (customerQuerySeqRef.current !== seq) return;
      setCustomers(page.items.map((customer) => ({ id: customer.id, name: customer.name })));
    } catch (error) {
      if (customerQuerySeqRef.current !== seq) return;
      setCustomersError(error instanceof Error ? error.message : 'Müşteriler yüklenemedi.');
    } finally {
      if (customerQuerySeqRef.current === seq) setCustomersLoading(false);
    }
  }, []);

  const loadCreateParticipants = useCallback(async (contextType: 'GENERAL' | 'CUSTOMER') => {
    const seq = ++createParticipantsSeqRef.current;
    setCreateParticipantsLoading(true);
    setCreateParticipantsError(null);
    try {
      const recipients = await listRecipients(contextType);
      if (createParticipantsSeqRef.current !== seq) return;
      setCreateParticipants(recipients);
    } catch (error) {
      if (createParticipantsSeqRef.current !== seq) return;
      setCreateParticipantsError(error instanceof Error ? error.message : 'Katılımcılar yüklenemedi.');
    } finally {
      if (createParticipantsSeqRef.current === seq) setCreateParticipantsLoading(false);
    }
  }, []);

  const openCreateFlow = useCallback(() => {
    setCreateOpen(true);
    setCreateContext('JOB');
    setSelectedJob(null);
    setSelectedCustomer(null);
    setCreateTitle('');
    setSelectedParticipantIds([]);
    setCreateErrors({});
    setCreateFlowError(null);
    loadJobs('');
  }, [loadJobs]);

  const closeCreateFlow = useCallback((restoreFocus: boolean) => {
    setCreateOpen(false);
    setCreateFlowError(null);
    if (restoreFocus) window.setTimeout(() => createTriggerRef.current?.focus(), 0);
  }, []);

  const switchCreateContext = useCallback((context: CreateContext) => {
    setCreateContext(context);
    setSelectedJob(null);
    setSelectedCustomer(null);
    setCreateTitle('');
    setSelectedParticipantIds([]);
    setCreateErrors({});
    setCreateFlowError(null);
    if (context === 'JOB') {
      setJobQuery('');
      loadJobs('');
    } else if (context === 'CUSTOMER') {
      setCustomerQuery('');
      loadCustomers('');
      loadCreateParticipants('CUSTOMER');
    } else {
      loadCreateParticipants('GENERAL');
    }
  }, [loadJobs, loadCustomers, loadCreateParticipants]);

  const reopenJobSearch = useCallback(() => {
    setSelectedJob(null);
    window.setTimeout(() => jobSearchRef.current?.focus(), 0);
  }, []);

  const reopenCustomerSearch = useCallback(() => {
    setSelectedCustomer(null);
    window.setTimeout(() => customerSearchRef.current?.focus(), 0);
  }, []);

  const submitCreate = useCallback(async () => {
    const errors: CreateErrors = {};
    if (createContext === 'JOB' && !selectedJob) {
      errors.job = 'İş seçin';
    }
    if (createContext === 'CUSTOMER' && !selectedCustomer) {
      errors.customer = 'Müşteri seçin';
    }
    if ((createContext === 'CUSTOMER' || createContext === 'GENERAL') && !createTitle.trim()) {
      errors.title = 'Konu yazın';
    }
    if ((createContext === 'CUSTOMER' || createContext === 'GENERAL') && selectedParticipantIds.length === 0) {
      errors.participants = 'En az bir katılımcı seçin';
    }
    setCreateErrors(errors);
    if (createErrorText(errors)) return;

    setCreateSubmitting(true);
    setCreateFlowError(null);
    try {
      const payload =
        createContext === 'JOB' && selectedJob
          ? {
              contextType: 'JOB' as const,
              jobId: selectedJob.id,
              participantUserIds: [selectedJob.assigneeId],
            }
          : createContext === 'CUSTOMER' && selectedCustomer
            ? {
                contextType: 'CUSTOMER' as const,
                customerId: selectedCustomer.id,
                title: createTitle.trim(),
                participantUserIds: selectedParticipantIds,
              }
            : {
                contextType: 'GENERAL' as const,
                title: createTitle.trim(),
                participantUserIds: selectedParticipantIds,
              };

      const conv = await createOrGetConversation(payload);
      closeCreateFlow(false);
      await loadConversations();
      invalidateThread();
      setSelectedId(conv.id);
      scrollModeRef.current = 'bottom';
      await loadMessages(conv.id);
    } catch (error) {
      setCreateFlowError(error instanceof Error ? error.message : 'Konuşma başlatılamadı.');
    } finally {
      setCreateSubmitting(false);
    }
  }, [
    createContext, selectedJob, selectedCustomer, createTitle, selectedParticipantIds,
    closeCreateFlow, loadConversations, loadMessages, invalidateThread,
  ]);

  const toggleParticipant = useCallback((userId: string) => {
    setSelectedParticipantIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId],
    );
    setCreateErrors((prev) => (prev.participants ? { ...prev, participants: undefined } : prev));
  }, []);

  // --- Render ---

  if (listState.kind === 'loading') {
    return <main className="workspace messaging-workspace"><h1 className="sr-only">Mesajlar</h1><LoadConversations /></main>;
  }
  if (listState.kind === 'error') {
    return (
      <main className="workspace messaging-workspace">
        <h1 className="sr-only">Mesajlar</h1>
        <ResultState status="error" title="Konuşmalar yüklenemedi" description={listState.message}
          action={<button className="primary-button" onClick={refresh}>Tekrar dene</button>} />
      </main>
    );
  }

  const selected = conversations.find((c) => c.id === selectedId);
  const isSending = draft?.status === 'sending';
  const emptyDescription = canCreate
    ? conversationView === 'active'
      ? 'Yeni konuşma butonu ile başlatabilirsiniz.'
      : 'Arşivlenen konuşmalar burada görünür.'
    : conversationView === 'active'
      ? 'Eklendiğiniz konuşmalar burada görünür.'
      : 'Arşivlediğiniz konuşmalar burada görünür.';

  return (
    <main className="workspace messaging-workspace">
      <h1 className="sr-only">Mesajlar</h1>
      <div className={`messaging-container${createOpen ? ' composing' : ''}`} ref={containerRef}>
        <aside className="messaging-sidebar">
          <header className="messaging-sidebar-header" hidden={createOpen}>
            <h2>Mesajlar</h2>
            <div className="conversation-view-tabs" aria-label="Konuşma görünümleri">
              <button
                ref={activeViewButtonRef}
                type="button"
                aria-pressed={conversationView === 'active'}
                className={`conversation-view-tab ${conversationView === 'active' ? 'selected' : ''}`}
                onClick={() => switchConversationView('active')}
              >
                Aktif
              </button>
              <button
                ref={archivedViewButtonRef}
                type="button"
                aria-pressed={conversationView === 'archived'}
                className={`conversation-view-tab ${conversationView === 'archived' ? 'selected' : ''}`}
                onClick={() => switchConversationView('archived')}
              >
                Arşiv
              </button>
            </div>
            {canCreate && (
              <button type="button" ref={createTriggerRef} className="secondary-button" onClick={openCreateFlow} aria-label="Yeni konuşma">Yeni konuşma</button>
            )}
          </header>
          {createOpen && (
            <div className="create-panel" ref={createFlowRef}>
              <header className="create-panel-header">
                <button className="ghost-button" onClick={() => closeCreateFlow(true)} aria-label="Mesajlara dön">← Mesajlara dön</button>
                <h3>Yeni konuşma</h3>
              </header>
              <p className="create-prompt">Ne hakkında konuşacaksınız?</p>
              <div className="create-contexts" role="radiogroup" aria-label="Konuşma bağlamı">
                {(['JOB', 'CUSTOMER', 'GENERAL'] as const).map((ctx) => (
                  <button
                    key={ctx}
                    type="button"
                    role="radio"
                    aria-checked={createContext === ctx}
                    className={`create-context-option ${createContext === ctx ? 'selected' : ''}`}
                    onClick={() => switchCreateContext(ctx)}
                  >
                    {CONTEXT_LABELS[ctx]}
                  </button>
                ))}
              </div>

              {createContext === 'JOB' && (
                <div className="create-field">
                  <label className="create-label" htmlFor={selectedJob ? undefined : 'create-job-search'}>İş <span className="required-mark">*</span></label>
                  {selectedJob ? (
                    <div className="create-selection-summary" aria-label="Seçilen iş">
                      <span className="create-selection-copy">
                        <strong className="create-selection-title">{selectedJob.title}</strong>
                        <span className="create-selection-meta">
                          {[selectedJob.customerName, jobCardStatusLabel(selectedJob.status as never)].filter(Boolean).join(' • ')}
                        </span>
                      </span>
                      <button type="button" className="ghost-button create-selection-change" onClick={reopenJobSearch}>
                        Değiştir
                      </button>
                    </div>
                  ) : (
                    <>
                      <input
                        ref={jobSearchRef}
                        id="create-job-search"
                        type="search"
                        className="create-search"
                        placeholder="İş ara…"
                        value={jobQuery}
                        onChange={(e) => { setJobQuery(e.target.value); loadJobs(e.target.value); }}
                        aria-label="İş ara"
                      />
                      {jobsLoading && <LoadRecipients />}
                      {jobsError && <div className="inline-error">{jobsError}<button className="ghost-button" onClick={() => loadJobs(jobQuery)}>Tekrar dene</button></div>}
                      <ul className="create-options" role="listbox" aria-label="İşler">
                        {jobs.map((job) => (
                          <li key={job.id} role="option" aria-selected="false">
                            <button
                              type="button"
                              className="create-option"
                              onClick={() => { setSelectedJob(job); setCreateErrors((prev) => ({ ...prev, job: undefined })); }}
                            >
                              <span className="create-option-title">{job.title}</span>
                              <span className="create-option-sub">
                                {[job.customerName, jobCardStatusLabel(job.status as never)].filter(Boolean).join(' • ')}
                              </span>
                            </button>
                          </li>
                        ))}
                        {!jobsLoading && !jobsError && jobs.length === 0 && (
                          <li className="empty-recipients"><EmptyState title="İş bulunamadı" /></li>
                        )}
                      </ul>
                    </>
                  )}
                  {createErrors.job && <p className="create-error" role="alert">{createErrors.job}</p>}
                  {selectedJob && (
                    <p className="create-participant-note">
                      Katılımcı: <strong>{selectedJob.assigneeName}</strong>
                      {selectedJob.assigneeId === user.id ? ' (siz)' : ''}
                    </p>
                  )}
                </div>
              )}

              {createContext === 'CUSTOMER' && (
                <div className="create-field">
                  <label className="create-label" htmlFor={selectedCustomer ? undefined : 'create-customer-search'}>Müşteri <span className="required-mark">*</span></label>
                  {selectedCustomer ? (
                    <div className="create-selection-summary" aria-label="Seçilen müşteri">
                      <strong className="create-selection-title">{selectedCustomer.name}</strong>
                      <button type="button" className="ghost-button create-selection-change" onClick={reopenCustomerSearch}>
                        Değiştir
                      </button>
                    </div>
                  ) : (
                    <>
                      <input
                        ref={customerSearchRef}
                        id="create-customer-search"
                        type="search"
                        className="create-search"
                        placeholder="Müşteri ara…"
                        value={customerQuery}
                        onChange={(e) => { setCustomerQuery(e.target.value); loadCustomers(e.target.value); }}
                        aria-label="Müşteri ara"
                      />
                      {customersLoading && <LoadRecipients />}
                      {customersError && <div className="inline-error">{customersError}<button className="ghost-button" onClick={() => loadCustomers(customerQuery)}>Tekrar dene</button></div>}
                      <ul className="create-options" role="listbox" aria-label="Müşteriler">
                        {customers.map((customer) => (
                          <li key={customer.id} role="option" aria-selected="false">
                            <button
                              type="button"
                              className="create-option"
                              onClick={() => { setSelectedCustomer(customer); setCreateErrors((prev) => ({ ...prev, customer: undefined })); }}
                            >
                              <span className="create-option-title">{customer.name}</span>
                            </button>
                          </li>
                        ))}
                        {!customersLoading && !customersError && customers.length === 0 && (
                          <li className="empty-recipients"><EmptyState title="Müşteri bulunamadı" /></li>
                        )}
                      </ul>
                    </>
                  )}
                  {createErrors.customer && <p className="create-error" role="alert">{createErrors.customer}</p>}
                </div>
              )}

              {(createContext === 'CUSTOMER' || createContext === 'GENERAL') && (
                <>
                  <div className="create-field">
                    <label className="create-label" htmlFor="create-topic">Konu <span className="required-mark">*</span></label>
                    <input
                      id="create-topic"
                      type="text"
                      className="create-search"
                      placeholder="Konu yazın…"
                      value={createTitle}
                      onChange={(e) => {
                        setCreateTitle(e.target.value);
                        setCreateErrors((prev) => (prev.title ? { ...prev, title: undefined } : prev));
                      }}
                      maxLength={255}
                      aria-label="Konu"
                    />
                    {createErrors.title && <p className="create-error" role="alert">{createErrors.title}</p>}
                  </div>
                  <div className="create-field">
                    <span className="create-label" id="create-participants-label">Katılımcılar <span className="required-mark">*</span></span>
                    {createParticipantsLoading && <LoadRecipients />}
                    {createParticipantsError && <div className="inline-error">{createParticipantsError}<button className="ghost-button" onClick={() => loadCreateParticipants(createContext === 'GENERAL' ? 'GENERAL' : 'CUSTOMER')}>Tekrar dene</button></div>}
                    <ul className="participant-options" role="group" aria-labelledby="create-participants-label">
                      {createParticipants.map((recipient) => {
                        const checked = selectedParticipantIds.includes(recipient.id);
                        return (
                          <li key={recipient.id}>
                            <label className={`participant-option ${checked ? 'selected' : ''}`}>
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleParticipant(recipient.id)}
                                aria-label={recipient.name}
                              />
                              <span className="participant-option-name">{recipient.name}</span>
                              <span className="participant-option-role">
                                {recipient.role === 'ADMIN' ? 'Yönetici' : recipient.role === 'MANAGER' ? 'Müdür' : 'Personel'}
                              </span>
                            </label>
                          </li>
                        );
                      })}
                      {!createParticipantsLoading && !createParticipantsError && createParticipants.length === 0 && (
                        <li className="empty-recipients"><EmptyState title="Katılımcı bulunamadı" /></li>
                      )}
                    </ul>
                    {selectedParticipantIds.length > 0 && (
                      <div className="selected-participants" aria-label="Seçilen katılımcılar">
                        {createParticipants
                          .filter((recipient) => selectedParticipantIds.includes(recipient.id))
                          .map((recipient) => (
                            <span key={recipient.id} className="selected-participant">
                              {recipient.name}
                              <button
                                type="button"
                                className="ghost-button selected-participant-remove"
                                onClick={() => toggleParticipant(recipient.id)}
                                aria-label={`${recipient.name} kaldır`}
                              >
                                ×
                              </button>
                            </span>
                          ))}
                      </div>
                    )}
                    {createErrors.participants && <p className="create-error" role="alert">{createErrors.participants}</p>}
                  </div>
                </>
              )}

              {createFlowError && <div className="inline-error">{createFlowError}</div>}
              <div className="create-actions">
                <button className="primary-button" onClick={submitCreate} disabled={createSubmitting}>
                  {createSubmitting ? 'Başlatılıyor…' : 'Konuşmayı başlat'}
                </button>
              </div>
            </div>
          )}
          {archiveError && <div className="archive-error" role="alert">{archiveError}</div>}
          {!createOpen && <ul className="conversation-list" aria-label="Konuşmalar">
            {conversations.map((conv) => (
              <li key={conv.id}>
                <div className="conversation-row">
                  <button type="button" className={`conversation-item ${conv.id === selectedId ? 'selected' : ''} ${conv.unreadCount > 0 ? 'unread' : ''}`} aria-current={conv.id === selectedId ? 'page' : undefined} onClick={() => selectConversation(conv)}>
                    <UserAvatar name={firstOtherParticipant(conv, user.id)} size="default" />
                    {conv.contextType === 'JOB' && conv.jobTitle ? (
                      <span className="conversation-meta">
                        <span className="conversation-name">{conv.jobTitle}</span>
                        <span className="conversation-context"><span className="context-chip">İş</span><span className="conversation-participants">{participantSummary(conv, user.id)}</span></span>
                      </span>
                    ) : conv.contextType === 'CUSTOMER' && conv.title ? (
                      <span className="conversation-meta">
                        <span className="conversation-name">{conv.title}</span>
                        <span className="conversation-context"><span className="context-chip">Müşteri</span><span className="conversation-participants">{conv.customerName ?? ''}</span></span>
                      </span>
                    ) : conv.title ? (
                      <span className="conversation-meta">
                        <span className="conversation-name">{conv.title}</span>
                        <span className="conversation-context"><span className="context-chip">Genel</span><span className="conversation-participants">{participantSummary(conv, user.id)}</span></span>
                      </span>
                    ) : (
                      <span className="conversation-meta">
                        <span className="conversation-name">{conv.participantName}{!conv.participantIsActive && <span className="disabled-badge">Pasif</span>}</span>
                        <span className="conversation-context"><span className="context-chip">Genel</span><span className="conversation-participants">{participantSummary(conv, user.id)}</span></span>
                      </span>
                    )}
                    <span className="conversation-activity"><span className="activity-time">{formatActivityTime(conv.lastActivityAt)}</span>{conv.unreadCount > 0 && <span className="unread-count">{conv.unreadCount}</span>}</span>
                  </button>
                  <details
                    className="conversation-actions"
                    onKeyDown={(event) => {
                      if (event.key !== 'Escape') return;
                      event.preventDefault();
                      event.currentTarget.open = false;
                      event.currentTarget.querySelector('summary')?.focus();
                    }}
                  >
                    <summary aria-label="Sohbet seçenekleri"><span aria-hidden="true" className="conversation-action-mark">...</span></summary>
                    <div className="conversation-action-menu" role="menu">
                      {conversationView === 'active' ? (
                        <button
                          type="button"
                          role="menuitem"
                          disabled={conv.unreadCount > 0 || archivePendingId !== null}
                          title={conv.unreadCount > 0 ? 'Okunmamış konuşmalar arşivlenemez.' : undefined}
                          onClick={(event) => {
                            const details = event.currentTarget.closest('details');
                            details?.removeAttribute('open');
                            void handleConversationArchive(conv, details?.querySelector<HTMLElement>('summary'));
                          }}
                        >
                          {archivePendingId === conv.id ? 'Arşivleniyor...' : 'Sohbeti arşivle'}
                        </button>
                      ) : (
                        <button
                          type="button"
                          role="menuitem"
                          disabled={archivePendingId !== null}
                          onClick={(event) => {
                            const details = event.currentTarget.closest('details');
                            details?.removeAttribute('open');
                            void handleConversationUnarchive(conv, details?.querySelector<HTMLElement>('summary'));
                          }}
                        >
                          {archivePendingId === conv.id ? 'Arşivden çıkarılıyor...' : 'Sohbeti arşivden çıkar'}
                        </button>
                      )}
                    </div>
                  </details>
                </div>
              </li>
            ))}
            {conversations.length === 0 && <li className="empty-conversations"><EmptyState title="Konuşma bulunmuyor" description={emptyDescription} /></li>}
          </ul>}
        </aside>
        {!createOpen && <section className={`messaging-thread${selected ? ' active' : ''}`} aria-label="Mesaj akışı">
          {selected ? (<>
            <header className="thread-header">
              <button className="ghost-button back-button" onClick={() => { invalidateThread(); setSelectedId(null); }} aria-label="Geri">←</button>
              {selected.contextType === 'JOB' && selected.jobTitle ? (
                <span className="thread-context">
                  <strong className="thread-context-title">{selected.jobTitle}</strong>
                  <small className="thread-context-meta"><span className="context-chip">İş</span>{participantSummary(selected, user.id)}</small>
                </span>
              ) : selected.contextType === 'CUSTOMER' && selected.title ? (
                <span className="thread-context">
                  <strong className="thread-context-title">{selected.title}</strong>
                  <small className="thread-context-meta"><span className="context-chip">Müşteri</span>{selected.customerName ?? ''}</small>
                </span>
              ) : selected.title ? (
                <span className="thread-context">
                  <strong className="thread-context-title">{selected.title}</strong>
                  <small className="thread-context-meta"><span className="context-chip">Genel</span>{participantSummary(selected, user.id)}</small>
                </span>
              ) : (
                <span className="thread-context">
                  <strong className="thread-context-title">{selected.participantName}{!selected.participantIsActive && <span className="disabled-badge">Pasif</span>}</strong>
                  <small className="thread-context-meta"><span className="context-chip">Genel</span>{participantSummary(selected, user.id)}</small>
                </span>
              )}
            </header>
            {markReadError && <div className="inline-error">{markReadError}<button className="ghost-button" onClick={retryMarkRead}>Tekrar dene</button></div>}
            <div className="thread-messages" role="log" aria-live="polite" ref={threadMessagesRef}>
              {olderCursor && <div className="older-messages-control"><button className="secondary-button" onClick={handleLoadOlder} disabled={olderLoading}>{olderLoading ? 'Yükleniyor…' : 'Daha eski mesajlar'}</button></div>}
              {threadError && <div className="inline-error">{threadError}<button className="ghost-button" onClick={() => selectedId && loadMessages(selectedId)}>Tekrar dene</button></div>}
              {messageLoading && <LoadMessages />}
              {!messageLoading && !threadError && messages.length === 0 && <EmptyState title="Henüz mesaj yok" description="İlk mesajı siz gönderin." />}
              {messages.map((msg) => { const isOwn = msg.senderUserId === user.id; return (<div key={msg.id} className={`message-bubble ${isOwn ? 'own' : 'other'}`}>{!isOwn && <span className="message-sender">{msg.senderName}</span>}<div className="message-body">{msg.body}</div><time className="message-time">{formatMessageTime(msg.createdAt)}</time></div>); })}
              {isSending && draft && <div className="message-bubble own pending"><div className="message-body">{draft.body}</div><time className="message-time">Gönderiliyor…</time></div>}
              <div ref={threadEndRef} />
            </div>
            <div className="thread-composer">
              {sendError && draft?.status === 'error' && <div className="inline-error">{sendError}<button className="ghost-button" onClick={() => handleSend()}>Tekrar gönder</button></div>}
              <textarea ref={composerRef} className="composer-input" placeholder="Mesajınızı yazın…" value={composerText} onChange={(e) => { setComposerText(e.target.value); if (draft && draft.body !== e.target.value) { setDraft(null); setSendError(null); } }} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }} maxLength={4000} rows={2} disabled={isSending || !selected.participantIsActive} aria-label="Mesaj metni" />
              <button className="primary-button send-button" onClick={() => handleSend()} disabled={!composerText.trim() || isSending || !selected.participantIsActive} aria-label="Gönder">Gönder</button>
              <div className="composer-hint">{selected.participantIsActive ? `Enter: gönder • Shift+Enter: alt satır • ${composerText.length}/4000` : 'Alıcı pasif durumda • Mesaj gönderilemez'}</div>
            </div>
          </>) : (
            <div className="thread-empty">
              {conversations.length === 0 ? (
                <EmptyState title="Henüz konuşma yok" description={emptyDescription} />
              ) : (
                <EmptyState title="Konuşma seçin" description="Sol taraftan bir konuşma seçin veya yeni bir konuşma başlatın." />
              )}
            </div>
          )}
        </section>}
      </div>
    </main>
  );
}
