import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { CurrentUser } from '../services/api';
import {
  createOrGetConversation,
  getUnreadCount,
  listConversations,
  listMessages,
  listRecipients,
  markRead,
  sendMessage,
  type Conversation,
  type Message,
  type Recipient,
} from '../services/messaging-api';
import { useRealtimeInvalidation } from '../realtime/RealtimeProvider';
import { LoadConversations, LoadMessages, LoadRecipients } from './MessagingSkeleton';
import { EmptyState } from '../ui/antd/EmptyState';
import { ResultState } from '../ui/antd/ResultState';
import { UserAvatar } from '../ui/antd/UserAvatar';
import './messaging.css';

type PageState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready' };

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

let clientActionCounter = 0;
function nextClientActionId(userId: string): string {
  return `msg-${userId}-${Date.now()}-${++clientActionCounter}`;
}

export function MessagingPage({ user }: { user: CurrentUser }) {
  const [searchParams] = useSearchParams();
  const [pageState, setPageState] = useState<PageState>({ kind: 'loading' });
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageLoading, setMessageLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [composerText, setComposerText] = useState('');
  const [draft, setDraft] = useState<DraftState>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [recipientsLoading, setRecipientsLoading] = useState(false);
  const [recipientsError, setRecipientsError] = useState<string | null>(null);
  const [showRecipientPicker, setShowRecipientPicker] = useState(false);
  const [unreadTotal, setUnreadTotal] = useState(0);
  const [markReadError, setMarkReadError] = useState<string | null>(null);
  const [convLoadError, setConvLoadError] = useState<string | null>(null);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [olderLoading, setOlderLoading] = useState(false);

  const threadEndRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const loadedPageRef = useRef<Message[]>([]);
  const scrollModeRef = useRef<ScrollMode>('bottom');
  const scrollRestoreRef = useRef({ prevHeight: 0, prevTop: 0 });
  const olderGenRef = useRef(0);
  const loadGenRef = useRef(0);
  const pendingOlderRef = useRef<OlderRequest | null>(null);
  const pendingLoadRef = useRef<{ gen: number; convId: string } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const threadMessagesRef = useRef<HTMLDivElement>(null);

  // --- Data loading ---

  const loadConversations = useCallback(async () => {
    try {
      const page = await listConversations();
      setConversations(page.items);
      setConvLoadError(null);
    } catch {
      setConvLoadError('Konuşmalar yüklenemedi.');
    }
  }, []);

  const loadUnreadCount = useCallback(async () => {
    try { setUnreadTotal(await getUnreadCount()); } catch { /* non-critical */ }
  }, []);

  const refresh = useCallback(async () => {
    setPageState((c) => (c.kind === 'ready' ? c : { kind: 'loading' }));
    try {
      await Promise.all([loadConversations(), loadUnreadCount()]);
      setPageState({ kind: 'ready' });
    } catch (error) {
      setPageState({ kind: 'error', message: error instanceof Error ? error.message : 'Yüklenemedi.' });
    }
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
  }, [pageState.kind]);

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
        // Invalidate any pending older request and load when realtime refreshes the thread
        olderGenRef.current++;
        loadGenRef.current++;
        pendingOlderRef.current = null;
        pendingLoadRef.current = null;
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
        setThreadError(error instanceof Error ? error.message : 'Mesajlar yüklenemedi.');
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

    const log = threadMessagesRef.current;
    const prevHeight = log?.scrollHeight ?? 0;
    const prevTop = log?.scrollTop ?? 0;

    // Set mode BEFORE any state update to prevent intermediate renders from scrolling to bottom
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
      // Invalidate any pending requests from previous conversation
      olderGenRef.current++;
      loadGenRef.current++;
      pendingOlderRef.current = null;
      pendingLoadRef.current = null;
      setSelectedId(conversation.id);
      setDraft(null);
      setSendError(null);
      setMarkReadError(null);
      scrollModeRef.current = 'bottom';

      const loadedMessages = await loadMessages(conversation.id);

      if (conversation.unreadCount > 0 && loadedMessages.length > 0) {
        const lastOtherMsg = [...loadedMessages].reverse().find((m) => m.senderUserId !== user.id);
        if (lastOtherMsg) {
          try {
            await markRead(conversation.id, lastOtherMsg.id);
            setMarkReadError(null);
          } catch (error) {
            setMarkReadError(error instanceof Error ? error.message : 'Okundu işaretlenemedi.');
          }
        }
        loadConversations();
        loadUnreadCount();
      }
    },
    [loadMessages, user.id, loadConversations, loadUnreadCount],
  );

  const retryMarkRead = useCallback(async () => {
    if (!selectedId) return;
    const loadedMessages = loadedPageRef.current;
    if (loadedMessages.length === 0) return;
    const lastOtherMsg = [...loadedMessages].reverse().find((m) => m.senderUserId !== user.id);
    if (!lastOtherMsg) return;
    try {
      await markRead(selectedId, lastOtherMsg.id);
      setMarkReadError(null);
      loadConversations();
      loadUnreadCount();
    } catch (error) {
      setMarkReadError(error instanceof Error ? error.message : 'Okundu işaretlenemedi.');
    }
  }, [selectedId, loadConversations, loadUnreadCount, user.id]);

  // Deep-link from notification center
  useEffect(() => {
    const convId = searchParams.get('conversation');
    if (convId && pageState.kind === 'ready') {
      const conv = conversations.find((c) => c.id === convId);
      if (conv) selectConversation(conv);
    }
  }, [pageState.kind, conversations, searchParams, selectConversation]);

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

  const handleNewConversation = useCallback(
    async (recipientId: string) => {
      try {
        const conv = await createOrGetConversation(recipientId);
        setShowRecipientPicker(false);
        await loadConversations();
        setSelectedId(conv.id);
        await loadMessages(conv.id);
      } catch (error) {
        setSendError(error instanceof Error ? error.message : 'Konuşma başlatılamadı.');
      }
    },
    [loadConversations, loadMessages],
  );

  const loadRecipientsForPicker = useCallback(async () => {
    setRecipientsLoading(true);
    setRecipientsError(null);
    try { setRecipients(await listRecipients()); } catch (error) {
      setRecipientsError(error instanceof Error ? error.message : 'Alıcılar yüklenemedi.');
    } finally { setRecipientsLoading(false); }
  }, []);

  // --- Render ---

  if (pageState.kind === 'loading') {
    return <main className="workspace messaging-workspace"><LoadConversations /></main>;
  }
  if (pageState.kind === 'error') {
    return (
      <main className="workspace messaging-workspace">
        <ResultState status="error" title="Yüklenemedi" description={pageState.message}
          action={<button className="primary-button" onClick={refresh}>Tekrar dene</button>} />
      </main>
    );
  }

  const selected = conversations.find((c) => c.id === selectedId);
  const isSending = draft?.status === 'sending';

  return (
    <main className="workspace messaging-workspace">
      <div className="messaging-container" ref={containerRef}>
        <aside className="messaging-sidebar">
          <header className="messaging-sidebar-header">
            <h2>Mesajlar</h2>
            <button className="secondary-button" onClick={() => { setShowRecipientPicker(true); loadRecipientsForPicker(); }} aria-label="Yeni mesaj">Yeni</button>
          </header>
          {convLoadError && <div className="inline-error">{convLoadError}<button className="ghost-button" onClick={loadConversations}>Tekrar dene</button></div>}
          {showRecipientPicker && (
            <div className="recipient-picker">
              <header><h3>Alıcı seçin</h3><button className="ghost-button" onClick={() => setShowRecipientPicker(false)} aria-label="Kapat">Kapat</button></header>
              {recipientsLoading && <LoadRecipients />}
              {recipientsError && <div className="inline-error">{recipientsError}<button className="ghost-button" onClick={loadRecipientsForPicker}>Tekrar dene</button></div>}
              <ul className="recipient-list">
                {recipients.map((r) => (
                  <li key={r.id}><button className="recipient-item" onClick={() => handleNewConversation(r.id)} disabled={!r.isActive}><UserAvatar name={r.name} size="default" /><span className="recipient-details"><strong>{r.name}</strong><small>{r.role === 'ADMIN' ? 'Yönetici' : r.role === 'MANAGER' ? 'Müdür' : 'Personel'}{!r.isActive ? ' (Pasif)' : ''}</small></span></button></li>
                ))}
                {!recipientsLoading && !recipientsError && recipients.length === 0 && <li className="empty-recipients"><EmptyState title="Alıcı bulunamadı" /></li>}
              </ul>
            </div>
          )}
          <ul className="conversation-list" role="listbox" aria-label="Konuşmalar">
            {conversations.map((conv) => (
              <li key={conv.id} role="option" aria-selected={conv.id === selectedId}>
                <button className={`conversation-item ${conv.id === selectedId ? 'selected' : ''} ${conv.unreadCount > 0 ? 'unread' : ''}`} onClick={() => selectConversation(conv)}>
                  <UserAvatar name={conv.participantName} size="default" />
                  <span className="conversation-meta">
                    <span className="conversation-name">{conv.participantName}{!conv.participantIsActive && <span className="disabled-badge">Pasif</span>}</span>
                    <span className="conversation-context">{conv.contextType === 'JOB' && conv.jobTitle ? `İş: ${conv.jobTitle}` : conv.contextType === 'GENERAL' ? 'Genel' : ''}</span>
                  </span>
                  <span className="conversation-activity"><span className="activity-time">{formatActivityTime(conv.lastActivityAt)}</span>{conv.unreadCount > 0 && <span className="unread-count">{conv.unreadCount}</span>}</span>
                </button>
              </li>
            ))}
            {conversations.length === 0 && <li className="empty-conversations"><EmptyState title="Konuşma bulunmuyor" description="Yeni butonu ile konuşma başlatabilirsiniz." /></li>}
          </ul>
        </aside>
        <section className={`messaging-thread${selected ? ' active' : ''}`} aria-label="Mesaj akışı">
          {selected ? (<>
            <header className="thread-header">
              <button className="ghost-button back-button" onClick={() => setSelectedId(null)} aria-label="Geri">←</button>
              <span className="thread-participant"><UserAvatar name={selected.participantName} size="default" /><span><strong>{selected.participantName}</strong>{!selected.participantIsActive && <span className="disabled-badge">Pasif</span>}{selected.contextType === 'JOB' && selected.jobTitle && <small>İş: {selected.jobTitle}</small>}</span></span>
            </header>
            {markReadError && <div className="inline-error">{markReadError}<button className="ghost-button" onClick={retryMarkRead}>Tekrar dene</button></div>}
            <div className="thread-messages" role="log" aria-live="polite" ref={threadMessagesRef}>
              {olderCursor && <div className="older-messages-control"><button className="secondary-button" onClick={handleLoadOlder} disabled={olderLoading}>{olderLoading ? 'Yükleniyor…' : 'Daha eski mesajlar'}</button></div>}
              {threadError && <div className="inline-error">{threadError}<button className="ghost-button" onClick={() => selectedId && loadMessages(selectedId)}>Tekrar dene</button></div>}
              {messageLoading && <LoadMessages />}
              {!messageLoading && !threadError && messages.length === 0 && <EmptyState title="Henüz mesaj yok" description="İlk mesajı siz gönderin." />}
              {messages.map((msg) => (<div key={msg.id} className={`message-bubble ${msg.senderUserId === user.id ? 'own' : 'other'}`}><div className="message-body">{msg.body}</div><time className="message-time">{formatMessageTime(msg.createdAt)}</time></div>))}
              {isSending && draft && <div className="message-bubble own pending"><div className="message-body">{draft.body}</div><time className="message-time">Gönderiliyor…</time></div>}
              <div ref={threadEndRef} />
            </div>
            <div className="thread-composer">
              {sendError && draft?.status === 'error' && <div className="inline-error">{sendError}<button className="ghost-button" onClick={() => handleSend()}>Tekrar gönder</button></div>}
              <textarea ref={composerRef} className="composer-input" placeholder="Mesajınızı yazın…" value={composerText} onChange={(e) => { setComposerText(e.target.value); if (draft && draft.body !== e.target.value) { setDraft(null); setSendError(null); } }} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }} maxLength={4000} rows={2} disabled={isSending || !selected.participantIsActive} aria-label="Mesaj metni" />
              <button className="primary-button send-button" onClick={() => handleSend()} disabled={!composerText.trim() || isSending || !selected.participantIsActive} aria-label="Gönder">Gönder</button>
              <div className="composer-hint">{selected.participantIsActive ? `Enter: gönder • Shift+Enter: alt satır • ${composerText.length}/4000` : 'Alıcı pasif durumda • Mesaj gönderilemez'}</div>
            </div>
          </>) : (<div className="thread-empty"><EmptyState title="Konuşma seçin" description="Sol taraftan bir konuşma seçin veya yeni bir konuşma başlatın." /></div>)}
        </section>
      </div>
    </main>
  );
}
