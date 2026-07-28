import { LoadingSkeleton } from '../ui/antd/LoadingSkeleton';

export function LoadConversations() {
  return (
    <div className="messaging-container">
      <aside className="messaging-sidebar">
        <LoadingSkeleton title="Mesajlar yükleniyor…" headingLevel={2} rows={4} />
      </aside>
      <section className="messaging-thread">
        <LoadingSkeleton title="Konuşma yükleniyor…" rows={3} />
      </section>
    </div>
  );
}

export function LoadMessages() {
  return (
    <div className="thread-messages-loading">
      <LoadingSkeleton title="Mesajlar yükleniyor…" rows={3} />
    </div>
  );
}

export function LoadRecipients() {
  return (
    <div className="recipient-picker-loading">
      <LoadingSkeleton title="Alıcılar yükleniyor…" rows={3} />
    </div>
  );
}
