import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import {type TimeEvidence} from '../../../../ops/scripts/trusted-time.mjs';

import {
  evaluateBackupProviderStatus,
  parseBackupObservationState,
  toCompatibilityStatus,
  toRunStatusVocabulary,
  type BackupObservationState,
  type BackupProviderStatus,
} from './backup-freshness.js';
import {createTrustedTimeSampler} from './trusted-time-sampler.js';
import type { BackupHealthReadinessPort, PublicBackupHealth } from './service.js';

/** Upper bound on the state artifact; v2 includes two private time proofs. */
const MAX_OBSERVATION_BYTES = 64 * 1024;

export type HostBackupObservationOptions = {
  /** Absolute path to `observation-v1.json`. Validated by config (fail-closed). */
  observationPath: string;
  sampleTime?: () => TimeEvidence|null|Promise<TimeEvidence|null>;
};

/**
 * Reads the observation artifact written by `backup-postgres.sh` and projects it
 * onto the public backup health contract.
 *
 * Fail-closed: a missing, unreadable, non-regular, symlinked, oversized or
 * malformed artifact is reported as `unavailable`. The reader never echoes a
 * path, filename, raw error, or artifact content into the response or the logs —
 * the public projection carries only the status vocabulary and safe instants.
 */
export function createHostBackupObservationHealth(
  options: HostBackupObservationOptions,
): BackupHealthReadinessPort {
  const sampler = options.sampleTime ? null : createTrustedTimeSampler();
  const sampleTime = options.sampleTime ?? (() => sampler!.sample());
  let checking=false,closed=false;
  const observationPath = options.observationPath;

  return {
    async check(): Promise<PublicBackupHealth> {
      if(checking||closed)return projectProviderState({provider:'host-observation',state:null,currentTime:null});
      checking=true;
      try {
        const state = await readObservationState(observationPath);
        let currentTime:TimeEvidence|null=null;
        if(state&&!closed) {
          try {currentTime=await sampleTime();if(closed)currentTime=null;}catch { /* Missing trusted time denies freshness. */ }
        }
        return projectProviderState({provider:'host-observation',state,currentTime});
      } finally {checking=false;}
    },
    async close(){closed=true;await sampler?.close();},
  };
}

/**
 * Intentionally-disabled provider. Distinct from "never observed": a mechanism
 * that was deliberately switched off is not a failed backup run.
 */
export function createDisabledBackupHealth(): BackupHealthReadinessPort {
  return {
    async check(): Promise<PublicBackupHealth> {
      return projectProviderState({ provider: 'none', state: null, currentTime:null, forcedStatus: 'disabled' });
    },
  };
}

async function readObservationState(observationPath: string): Promise<BackupObservationState | null> {
  let handle;
  try {
    // O_NOFOLLOW closes the symlink-substitution path: the canonical state file
    // must be a regular file, never a link someone could repoint.
    handle = await open(observationPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_OBSERVATION_BYTES) return null;
    const raw = await handle.readFile({ encoding: 'utf8' });
    return parseBackupObservationState(JSON.parse(raw) as unknown);
  } catch {
    // Missing file, permission denied, symlink refusal, malformed JSON,
    // oversized artifact — all untrusted, all `unavailable`.
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export type ProjectProviderStateInput = {
  provider: PublicBackupHealth['provider'];
  state: BackupObservationState | null;
  currentTime: TimeEvidence|null;
  /** Overrides evaluation when the mechanism is intentionally disabled. */
  forcedStatus?: BackupProviderStatus;
};

/**
 * Projects a provider observation onto the public contract.
 *
 * The compatibility `status` field keeps its pre-existing meaning and is `ok`
 * only for the fully healthy provider state; the additive `provider` /
 * `providerStatus` fields carry the richer accepted vocabulary. Only the host
 * provider currently populates the attempt-level additive fields.
 */
export function projectProviderState(input: ProjectProviderStateInput): PublicBackupHealth {
  const { provider, state, currentTime, forcedStatus } = input;
  const providerStatus = forcedStatus ?? evaluateBackupProviderStatus(state, currentTime);
  return {
    status: toCompatibilityStatus(providerStatus),
    latestVerifiedAt: state?.latestVerifiedSuccess?.verifiedAt ?? null,
    latestScheduledVerifiedAt: state?.latestScheduledVerifiedSuccess?.verifiedAt ?? null,
    latestRunStatus: toRunStatusVocabulary(state?.latestAttempt?.result ?? null),
    latestScheduledRunStatus: toRunStatusVocabulary(state?.latestScheduledAttempt?.result ?? null),
    // The host provider has no worker/scheduler process to report.
    workerHeartbeatAt: null,
    schedulerLastTickAt: null,
    provider,
    providerStatus,
    observationUpdatedAt: state?.updatedAt ?? null,
    latestAttemptAt: state?.latestAttempt?.startedAt ?? null,
    latestAttemptCompletedAt: state?.latestAttempt?.completedAt ?? null,
    latestAttemptTrigger: state?.latestAttempt?.trigger ?? null,
    latestAttemptFailureClass: state?.latestAttempt?.failureClass ?? null,
  };
}
