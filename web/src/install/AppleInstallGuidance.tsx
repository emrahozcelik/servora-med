/** Dismissible Apple/iPhone/iPad install guidance card. Not a modal: no focus trap,
 *  no overlay, renders inside the authenticated shell content flow. */
export function AppleInstallGuidance({ onDismiss }: Readonly<{ onDismiss: () => void }>) {
  return (
    <section
      className="apple-install-guidance surface-flat"
      role="region"
      aria-label="Servora'yı ana ekrana ekleyin"
      data-install-guidance="true"
    >
      <div className="apple-install-guidance-heading">
        <h2>Servora'yı ana ekrana ekleyin</h2>
        <button
          type="button"
          className="icon-button apple-install-guidance-dismiss"
          aria-label="Kurulum yönergesini kapat"
          onClick={onDismiss}
        >
          Kapat
        </button>
      </div>
      <p>iPhone veya iPad'de Servora'yı uygulama gibi kullanabilirsiniz.</p>
      <ol className="apple-install-guidance-steps">
        <li>Sayfayı Safari'de açın.</li>
        <li>Paylaş düğmesine dokunun.</li>
        <li>“Ana Ekrana Ekle” seçeneğini seçin.</li>
        <li>“Web Uygulaması Olarak Aç” seçeneği gösteriliyorsa açık bırakın.</li>
        <li>Ekle'ye dokunun.</li>
      </ol>
    </section>
  );
}
