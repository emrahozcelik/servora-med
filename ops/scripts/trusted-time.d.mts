type TimeAnchor = {
  source: 'linux-boottime'; bootId: string; timeNamespaceId: string;
  bootLowerMs: number; bootUpperMs: number; wallAtUTC: string; wallResolutionMs: 1;
};
type Metrics = {service: 'chrony'; referenceAgeMs: number; rootDistanceMs: number; correctionMs: number};
export type LegacyTimeEvidence = TimeAnchor & {formatVersion: 1; synchronization: Metrics & {sourceCount: 2}};
export type CurrentTimeEvidence = TimeAnchor & {formatVersion: 2; synchronization: Metrics & {
  sourceCount: 2 | 3; sourcePolicy: 'nts-quorum-v1'; configSha256: string; configuredSourceCount: 3;
  authenticatedSourceCount: 2 | 3; selectableSources: string[]; selectedSource: string;
}};
export type TimeEvidence = LegacyTimeEvidence | CurrentTimeEvidence;
export const SOURCE_POLICY: 'nts-quorum-v1';
export const NTS_SOURCES: readonly string[];
export const MONITOR_SOURCE: string;
export const CHRONY_CONFIG_SHA256: string;
export const MAX_REFERENCE_AGE_MS: number;
export const MAX_ROOT_DISTANCE_MS: number;
export const MAX_CORRECTION_MS: number;
/** Structural/historical only. Does not establish current authority. */
export function validateTimeEvidence(value: unknown): TimeEvidence;
export function validateCurrentTimeEvidence(value: unknown): CurrentTimeEvidence;
export function elapsedTime(event: unknown, current: unknown):
  {status: 'UNKNOWN'} | {status: 'KNOWN'; lowerMs: number; upperMs: number};
export function elapsedBootTime(event: unknown, current: unknown):
  {status: 'UNKNOWN'} | {status: 'KNOWN'; lowerMs: number; upperMs: number};
export function parseSynchronization(tracking: string, sources: string, nowMs: number, details: {
  config: string; selectdata: string; authdata: string;
  packets: {name: string; address: string; data: string}[];
}): CurrentTimeEvidence['synchronization'];
export function evidenceFromLinuxReads(reads: {
  bootBefore: string; bootAfter: string; namespaceBefore: string; namespaceAfter: string;
  uptimeBefore: string; uptimeAfter: string; wallAtUTC: string;
  synchronization: CurrentTimeEvidence['synchronization'];
}): CurrentTimeEvidence;
export function sampleTrustedTime(): CurrentTimeEvidence;
/** On-demand, request-bound read path; no caller parameters or persistent cache. */
export function readRestrictedTime(): Promise<CurrentTimeEvidence>;
export function validateRestrictedReply(reply: unknown, context: unknown): CurrentTimeEvidence;

export function validateReaderSocketMetadata(info: import("node:fs").Stats, gid: number): {dev: number;ino: number};

export const READER_UNIT_SHA256: string;
export const READER_SOCKET_UNIT_SHA256: string;
