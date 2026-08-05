/** Shared Apple/iPhone/iPad install step list. Single source of truth for the
 *  guidance wording; rendered inside the global shell card and the settings
 *  application page — never both on the same route. */
export function AppleInstallSteps() {
  return (
    <ol className="apple-install-guidance-steps">
      <li>Sayfayı Safari'de açın.</li>
      <li>Paylaş düğmesine dokunun.</li>
      <li>“Ana Ekrana Ekle” seçeneğini seçin.</li>
      <li>“Web Uygulaması Olarak Aç” seçeneği gösteriliyorsa açık bırakın.</li>
      <li>Ekle'ye dokunun.</li>
    </ol>
  );
}
