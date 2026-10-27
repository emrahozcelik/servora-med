export type TimeEvidence = {
  formatVersion: 1;
  source: 'linux-boottime';
  bootId: string;
  timeNamespaceId: string;
  bootLowerMs: number;
  bootUpperMs: number;
  wallAtUTC: string;
  wallResolutionMs: 1;
  synchronization: { service: 'chrony'; referenceAgeMs: number; rootDistanceMs: number;
    correctionMs: number; sourceCount: 2 };
};
export const MAX_REFERENCE_AGE_MS: number;
export const MAX_ROOT_DISTANCE_MS: number;
export const MAX_CORRECTION_MS: number;
export function validateTimeEvidence(value: unknown): TimeEvidence;
export function elapsedTime(event: unknown, current: unknown):
  { status: 'UNKNOWN' } | { status: 'KNOWN'; lowerMs: number; upperMs: number };
export function elapsedBootTime(event: unknown, current: unknown):
  { status: 'UNKNOWN' } | { status: 'KNOWN'; lowerMs: number; upperMs: number };
export function parseSynchronization(tracking: string, sources: string, nowMs: number): TimeEvidence['synchronization'];
export function evidenceFromLinuxReads(reads: {
  bootBefore: string; bootAfter: string; namespaceBefore: string; namespaceAfter: string;
  uptimeBefore: string; uptimeAfter: string; wallAtUTC: string;
  synchronization: TimeEvidence['synchronization'];
}): TimeEvidence;
export function sampleTrustedTime(): TimeEvidence;
