import { AppleInstallSteps } from './AppleInstallSteps';

/** Dismissible Apple/iPhone/iPad install guidance card. Not a modal: no focus trap,
 *  no overlay, renders inside the authenticated shell content flow. */
export function AppleInstallGuidance({ onDismiss }: Readonly<{ onDismiss: () => void }>) {
  return (
    <section
      className="apple-install-guidance surface-flat"
      role="region"
      aria-label="Dünya Dental'i ana ekrana ekleyin"
      data-install-guidance="true"
    >
      <div className="apple-install-guidance-heading">
        <h2>Dünya Dental'i ana ekrana ekleyin</h2>
        <button
          type="button"
          className="icon-button apple-install-guidance-dismiss"
          aria-label="Kurulum yönergesini kapat"
          onClick={onDismiss}
        >
          Kapat
        </button>
      </div>
      <p>iPhone veya iPad'de Dünya Dental'i uygulama gibi kullanabilirsiniz.</p>
      <AppleInstallSteps />
    </section>
  );
}
