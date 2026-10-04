/**
 * Slice 2 shared presentation for a server-computed comparison distance.
 *
 * Server owns metres; this only *presents* them. Sub-kilometre distances
 * render in metres, anything at/above a kilometre in kilometres with one
 * tr-TR decimal. Never implies precision beyond the data: callers prefix
 * with "yaklaşık" (approximate) themselves where the sentence needs it.
 */
export function formatLocationDistance(distanceMeters: number): string {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) return '—';
  if (distanceMeters < 1000) {
    const metres = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 })
      .format(distanceMeters);
    return `${metres} metre`;
  }
  const kilometres = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 })
    .format(distanceMeters / 1000);
  return `${kilometres} km`;
}

/**
 * Slice 2 advisory post-submit notice for a DIFFERENT classification.
 *
 * Informational only: the submission already succeeded (no second request),
 * the evidence is in the authorized job history, and the copy implies no
 * misconduct and no precision beyond the data.
 */
export function submitComparisonWarning(distanceMeters: number): string {
  return `Başlangıç konumu ile onaya gönderme konumu arasında yaklaşık `
    + `${formatLocationDistance(distanceMeters)} fark tespit edildi. `
    + `Bu bilgi iş geçmişine kaydedildi ve yönetici tarafından görülebilir.`;
}
