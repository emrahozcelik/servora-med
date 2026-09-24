/**
 * Browser download trigger for an in-memory blob.
 *
 * The object URL is released on a macrotask rather than synchronously: some
 * browsers abort an in-flight download if its URL is revoked in the same tick
 * as the synthetic click. Every path — success or failure — releases exactly
 * one URL.
 */
export function saveBlobAs(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    setTimeout(() => { URL.revokeObjectURL(url); }, 0);
  }
}
