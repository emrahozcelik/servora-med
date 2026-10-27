/** Canonical host backup freshness policy (OPS-004 / TT-B). */
import {elapsedBootTime, elapsedTime, type TimeEvidence} from '../../../../ops/scripts/trusted-time.mjs';
import {validateVerificationProof,type BackupAttemptResult,type BackupObservationState, type BackupObservationSuccess} from '../../../../ops/scripts/backup-observation.mjs';
export {BACKUP_TRIGGER_CLASSES,BACKUP_ATTEMPT_RESULTS,BACKUP_FAILURE_CLASSES,BACKUP_OBSERVATION_SCHEMA_VERSION,
  parseObservationInstant,parseBackupObservationState} from '../../../../ops/scripts/backup-observation.mjs';
export type {BackupTriggerClass,BackupAttemptResult,BackupFailureClass,BackupObservationAttempt,
  BackupObservationSuccess,BackupObservationState} from '../../../../ops/scripts/backup-observation.mjs';
export type BackupProviderStatus='healthy'|'stale'|'failed'|'unavailable'|'disabled';
export const BACKUP_LOCAL_FRESHNESS_MAX_AGE_MS=26*60*60*1000;

function freshness(success:BackupObservationSuccess|null,current:TimeEvidence|null):'healthy'|'stale'|'unavailable' {
  const proof=success?.proof;
  if(!proof||!current||!validateVerificationProof(proof,success.trigger,success.verifiedAt))return 'unavailable';
  if(Date.parse(success.verifiedAt)>Date.parse(current.wallAtUTC))return 'unavailable';
  const event={...proof.before,bootUpperMs:proof.after.bootUpperMs,wallAtUTC:proof.after.wallAtUTC};
  const bounds=elapsedBootTime(event,current);
  if(bounds.status!=='KNOWN')return 'unavailable';
  if(bounds.lowerMs>BACKUP_LOCAL_FRESHNESS_MAX_AGE_MS)return 'stale';
  const consistent=elapsedTime(event,current);
  return consistent.status==='KNOWN'&&consistent.upperMs<=BACKUP_LOCAL_FRESHNESS_MAX_AGE_MS?'healthy':'unavailable';
}

/**
 * Schedule heartbeat (host-backup-observability.md §5).
 *
 * `null` means the scheduled baseline is not established yet: no completed
 * scheduled success has been accepted, so a first scheduled attempt that is
 * still running has nothing trustworthy to compare against.
 *
 * `false` means either an explicit scheduled failure was observed or the prior
 * scheduled verified baseline is no longer fresh. A running attempt does not
 * erase that baseline: its heartbeat remains true or false according to the
 * prior verified instant. Deploy/manual backups cannot satisfy this dimension.
 */
export function evaluateScheduledHeartbeat(state:BackupObservationState,current:TimeEvidence|null):boolean|null {
  if(state.latestScheduledAttempt?.result==='failure')return false;
  const quality=freshness(state.latestScheduledVerifiedSuccess,current);
  return quality==='healthy'?true:quality==='stale'?false:null;
}

/** Failure wins; a known stale dimension denies even if another dimension is unknown. */
export function evaluateBackupProviderStatus(state:BackupObservationState|null,current:TimeEvidence|null|number):BackupProviderStatus {
  if(!state)return 'unavailable';
  if(state.latestAttempt?.result==='failure'||state.latestScheduledAttempt?.result==='failure')return 'failed';
  if(state.schemaVersion!==2||typeof current==='number')return 'unavailable';
  const local=freshness(state.latestVerifiedSuccess,current);
  const scheduled=state.scheduledBaselineEstablished?freshness(state.latestScheduledVerifiedSuccess,current):'healthy';
  if(local==='stale'||scheduled==='stale')return 'stale';
  return local==='healthy'&&scheduled==='healthy'?'healthy':'unavailable';
}

/**
 * Compatibility aggregate for the pre-existing `status: 'ok' | 'unavailable'`
 * field. `ok` is only ever reported for the fully healthy provider state, so
 * every richer state degrades to the conservative value existing consumers
 * already handle.
 */
export function toCompatibilityStatus(providerStatus: BackupProviderStatus): 'ok' | 'unavailable' {
  return providerStatus === 'healthy' ? 'ok' : 'unavailable';
}

/** Maps an observation attempt result into the existing run-status vocabulary. */
export function toRunStatusVocabulary(result: BackupAttemptResult | null): string | null {
  if (result === null) return null;
  if (result === 'success') return 'SUCCESS';
  if (result === 'failure') return 'FAILED';
  return 'RUNNING';
}
