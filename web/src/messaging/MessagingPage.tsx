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
  const [composerText, setComposerText] = useState('');
  const [sending, setSending] = useState(false);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [showRecipientPicker, setShowRecipientPicker] = useState(false);
  const [unreadTotal, setUnreadTotal] = useState(0);

  const threadEndRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const loadConversations = useCallback(async () => {
    try {
      const page = await listConversations();
      setConversations(page.items);
    } catch {
      // keep stale data
    }
  }, []);

  const loadUnreadCount = useCallback(async () => {
    try {
      setUnreadTotal(await getUnreadCount());
    } catch {
      // ignore
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
  });

  useRealtimeInvalidation(
    selectedId ? [`conversation:${selectedId}`] : [],
    () => {
      if (selectedId) loadMessages(selectedId);
      loadConversations();
      loadUnreadCount();
    },
  );

  const loadMessages = useCallback(async (conversationId: string) => {
    setMessageLoading(true);
    try {
      const page = await listMessages(conversationId);
      setMessages(page.items);
    } finally {
      setMessageLoading(false);
    }
  }, []);

  const selectConversation = useCallback(
    async (conversation: Conversation) => {
      setSelectedId(conversation.id);
      await loadMessages(conversation.id);
      if (conversation.unreadCount > 0) {
        const lastMsg = messages[messages.length - 1];
        if (lastMsg) {
          try { await markRead(conversation.id, lastMsg.id); } catch { /* ignore */ }
        }
        loadConversations();
        loadUnreadCount();
      }
    },
    [loadMessages, messages, loadConversations, loadUnreadCount],
  );

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
      if (!text || !selectedId || sending) return;

      setSending(true);
      const clientActionId = nextClientActionId(user.id);
      try {
        const msg = await sendMessage(selectedId, text, clientActionId);
        if (!msg.isDuplicate) {
          setMessages((prev) => [...prev, msg]);
          setComposerText('');
          loadConversations();
          loadUnreadCount();
        }
      } catch (error) {
        // Keep text in composer for retry
      } finally {
        setSending(false);
      }
    },
    [composerText, selectedId, sending, user.id, loadConversations, loadUnreadCount],
  );

  const handleNewConversation = useCallback(
    async (recipientId: string) => {
      try {
        const conv = await createOrGetConversation(recipientId);
        setShowRecipientPicker(false);
        await loadConversations();
        setSelectedId(conv.id);
        await loadMessages(conv.id);
      } catch {
        // error handled by toast
      }
    },
    [loadConversations, loadMessages],
  );

  const loadRecipientsForPicker = useCallback(async () => {
    try {
      setRecipients(await listRecipients());
    } catch {
      // ignore
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
                {recipients.length === 0 && (
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

        <section className="messaging-thread" aria-label="Mesaj akışı">
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

              <div className="thread-messages" role="log" aria-live="polite">
                {messageLoading && <LoadMessages />}
                {!messageLoading && messages.length === 0 && (
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
                {sending && (
                  <div className="message-bubble own pending">
                    <div className="message-body">{composerText}</div>
                    <time className="message-time">Gönderiliyor…</time>
                  </div>
                )}
                <div ref={threadEndRef} />
              </div>

              <div className="thread-composer">
                <textarea
                  ref={composerRef}
                  className="composer-input"
                  placeholder="Mesajınızı yazın…"
                  value={composerText}
                  onChange={(e) => setComposerText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  maxLength={4000}
                  rows={2}
                  disabled={sending || !selected.participantIsActive}
                  aria-label="Mesaj metni"
                />
                <button
                  className="primary-button send-button"
                  onClick={() => handleSend()}
                  disabled={!composerText.trim() || sending || !selected.participantIsActive}
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
