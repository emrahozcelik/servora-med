import { useCallback, useEffect, useRef, useState } from 'react';
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

  const threadEndRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const loadedPageRef = useRef<Message[]>([]);

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
    try {
      setUnreadTotal(await getUnreadCount());
    } catch {
      // Non-critical, silently ignore
    }
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

  useRealtimeInvalidation(['conversations', 'message-unread'], () => {
    loadConversations();
    loadUnreadCount();
    setMarkReadError(null);
  });

  useRealtimeInvalidation(
    selectedId ? [`conversation:${selectedId}`] : [],
    () => {
      if (selectedId) loadMessages(selectedId);
      loadConversations();
      loadUnreadCount();
    },
  );

  const loadMessages = useCallback(async (conversationId: string): Promise<Message[]> => {
    setMessageLoading(true);
    setThreadError(null);
    try {
      const page = await listMessages(conversationId);
      const items = page.items;
      setMessages(items);
      loadedPageRef.current = items;
      return items;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Mesajlar yüklenemedi.';
      setThreadError(message);
      return [];
    } finally {
      setMessageLoading(false);
    }
  }, []);

  const selectConversation = useCallback(
    async (conversation: Conversation) => {
      setSelectedId(conversation.id);
      setDraft(null);
      setSendError(null);
      setMarkReadError(null);

      const loadedMessages = await loadMessages(conversation.id);

      if (conversation.unreadCount > 0 && loadedMessages.length > 0) {
        // Find the last message from another user (not the viewer) to mark as read
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
    // Find the last message from another user (not the viewer)
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

  useEffect(() => {
    if (threadEndRef.current) {
      threadEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  const handleSend = useCallback(
    async (e?: React.KeyboardEvent) => {
      if (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
        } else if (e.key !== 'Enter') {
          return;
        }
        if (e.shiftKey && e.key === 'Enter') return;
      }

      const text = composerText.trim();
      if (!text || !selectedId) return;

      // If draft already exists with same body, reuse clientActionId for retry
      const effectiveActionId = draft?.body === text ? draft.clientActionId : nextClientActionId(user.id);

      setDraft({ body: text, clientActionId: effectiveActionId, status: 'sending' });
      setSendError(null);

      try {
        const msg = await sendMessage(selectedId, text, effectiveActionId);
        if (!msg.isDuplicate) {
          setMessages((prev) => [...prev, msg]);
        }
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
    try {
      setRecipients(await listRecipients());
    } catch (error) {
      setRecipientsError(error instanceof Error ? error.message : 'Alıcılar yüklenemedi.');
    } finally {
      setRecipientsLoading(false);
    }
  }, []);

  if (pageState.kind === 'loading') {
    return (
      <main className="workspace messaging-workspace">
        <LoadConversations />
      </main>
    );
  }

  if (pageState.kind === 'error') {
    return (
      <main className="workspace messaging-workspace">
        <ResultState
          status="error"
          title="Yüklenemedi"
          description={pageState.message}
          action={<button className="primary-button" onClick={refresh}>Tekrar dene</button>}
        />
      </main>
    );
  }

  const selected = conversations.find((c) => c.id === selectedId);
  const isSending = draft?.status === 'sending';

  return (
    <main className="workspace messaging-workspace">
      <div className="messaging-container">
        <aside className="messaging-sidebar">
          <header className="messaging-sidebar-header">
            <h2>Mesajlar</h2>
            <button
              className="secondary-button"
              onClick={() => {
                setShowRecipientPicker(true);
                loadRecipientsForPicker();
              }}
              aria-label="Yeni mesaj"
            >
              Yeni
            </button>
          </header>

          {convLoadError && (
            <div className="inline-error">
              {convLoadError}
              <button className="ghost-button" onClick={loadConversations}>Tekrar dene</button>
            </div>
          )}

          {showRecipientPicker && (
            <div className="recipient-picker">
              <header>
                <h3>Alıcı seçin</h3>
                <button
                  className="ghost-button"
                  onClick={() => setShowRecipientPicker(false)}
                  aria-label="Kapat"
                >
                  Kapat
                </button>
              </header>
              {recipientsLoading && <LoadRecipients />}
              {recipientsError && (
                <div className="inline-error">
                  {recipientsError}
                  <button className="ghost-button" onClick={loadRecipientsForPicker}>Tekrar dene</button>
                </div>
              )}
              <ul className="recipient-list">
                {recipients.map((r) => (
                  <li key={r.id}>
                    <button
                      className="recipient-item"
                      onClick={() => handleNewConversation(r.id)}
                      disabled={!r.isActive}
                    >
                      <UserAvatar name={r.name} size="default" />
                      <span className="recipient-details">
                        <strong>{r.name}</strong>
                        <small>{r.role === 'ADMIN' ? 'Yönetici' : r.role === 'MANAGER' ? 'Müdür' : 'Personel'}{!r.isActive ? ' (Pasif)' : ''}</small>
                      </span>
                    </button>
                  </li>
                ))}
                {!recipientsLoading && !recipientsError && recipients.length === 0 && (
                  <li className="empty-recipients">
                    <EmptyState title="Alıcı bulunamadı" />
                  </li>
                )}
              </ul>
            </div>
          )}

          <ul className="conversation-list" role="listbox" aria-label="Konuşmalar">
            {conversations.map((conv) => (
              <li key={conv.id} role="option" aria-selected={conv.id === selectedId}>
                <button
                  className={`conversation-item ${conv.id === selectedId ? 'selected' : ''} ${conv.unreadCount > 0 ? 'unread' : ''}`}
                  onClick={() => selectConversation(conv)}
                >
                  <UserAvatar name={conv.participantName} size="default" />
                  <span className="conversation-meta">
                    <span className="conversation-name">
                      {conv.participantName}
                      {!conv.participantIsActive && <span className="disabled-badge">Pasif</span>}
                    </span>
                    <span className="conversation-context">
                      {conv.contextType === 'JOB' && conv.jobTitle
                        ? `İş: ${conv.jobTitle}`
                        : conv.contextType === 'GENERAL'
                          ? 'Genel'
                          : ''}
                    </span>
                  </span>
                  <span className="conversation-activity">
                    <span className="activity-time">{formatActivityTime(conv.lastActivityAt)}</span>
                    {conv.unreadCount > 0 && (
                      <span className="unread-count">{conv.unreadCount}</span>
                    )}
                  </span>
                </button>
              </li>
            ))}
            {conversations.length === 0 && (
              <li className="empty-conversations">
                <EmptyState title="Konuşma bulunmuyor" description="Yeni butonu ile konuşma başlatabilirsiniz." />
              </li>
            )}
          </ul>
        </aside>

        <section className={`messaging-thread${selected ? ' active' : ''}`} aria-label="Mesaj akışı">
          {selected ? (
            <>
              <header className="thread-header">
                <button
                  className="ghost-button back-button"
                  onClick={() => setSelectedId(null)}
                  aria-label="Geri"
                >
                  ←
                </button>
                <span className="thread-participant">
                  <UserAvatar name={selected.participantName} size="default" />
                  <span>
                    <strong>{selected.participantName}</strong>
                    {!selected.participantIsActive && <span className="disabled-badge">Pasif</span>}
                    {selected.contextType === 'JOB' && selected.jobTitle && (
                      <small>İş: {selected.jobTitle}</small>
                    )}
                  </span>
                </span>
              </header>

              {markReadError && (
                <div className="inline-error">
                  {markReadError}
                  <button className="ghost-button" onClick={retryMarkRead}>Tekrar dene</button>
                </div>
              )}

              <div className="thread-messages" role="log" aria-live="polite">
                {threadError && (
                  <div className="inline-error">
                    {threadError}
                    <button className="ghost-button" onClick={() => selectedId && loadMessages(selectedId)}>Tekrar dene</button>
                  </div>
                )}
                {messageLoading && <LoadMessages />}
                {!messageLoading && !threadError && messages.length === 0 && (
                  <EmptyState title="Henüz mesaj yok" description="İlk mesajı siz gönderin." />
                )}
                {messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`message-bubble ${msg.senderUserId === user.id ? 'own' : 'other'}`}
                  >
                    <div className="message-body">{msg.body}</div>
                    <time className="message-time">{formatMessageTime(msg.createdAt)}</time>
                  </div>
                ))}
                {isSending && draft && (
                  <div className="message-bubble own pending">
                    <div className="message-body">{draft.body}</div>
                    <time className="message-time">Gönderiliyor…</time>
                  </div>
                )}
                <div ref={threadEndRef} />
              </div>

              <div className="thread-composer">
                {sendError && draft?.status === 'error' && (
                  <div className="inline-error">
                    {sendError}
                    <button className="ghost-button" onClick={() => handleSend()}>Tekrar gönder</button>
                  </div>
                )}
                <textarea
                  ref={composerRef}
                  className="composer-input"
                  placeholder="Mesajınızı yazın…"
                  value={composerText}
                  onChange={(e) => {
                    setComposerText(e.target.value);
                    // New text means new message — clear draft on change
                    if (draft && draft.body !== e.target.value) {
                      setDraft(null);
                      setSendError(null);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  maxLength={4000}
                  rows={2}
                  disabled={isSending || !selected.participantIsActive}
                  aria-label="Mesaj metni"
                />
                <button
                  className="primary-button send-button"
                  onClick={() => handleSend()}
                  disabled={!composerText.trim() || isSending || !selected.participantIsActive}
                  aria-label="Gönder"
                >
                  Gönder
                </button>
                <div className="composer-hint">
                  {selected.participantIsActive
                    ? `Enter: gönder • Shift+Enter: alt satır • ${composerText.length}/4000`
                    : 'Alıcı pasif durumda • Mesaj gönderilemez'}
                </div>
              </div>
            </>
          ) : (
            <div className="thread-empty">
              <EmptyState title="Konuşma seçin" description="Sol taraftan bir konuşma seçin veya yeni bir konuşma başlatın." />
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
