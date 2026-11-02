// Constructs a SYNTHETIC accepted checkpoint solely to test terminal I/O.
// This is not observation evidence and is NEVER installed with the root tool.
import assert from 'node:assert/strict';
import {hostname} from 'node:os';
import {readFileSync, unlinkSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {PATHS, createHostIO} from '../scripts/forward-host.mjs';
import {validateHostLog} from '../scripts/forward-host-driver.mjs';
import {advanceForwardTransition, recordForwardObservation, sealForwardAcceptance} from '../scripts/forward-transition.mjs';
import {openHostJournal, flushDirectory} from '../scripts/forward-host-storage.mjs';
import {seal} from '../scripts/forward-host-evidence.mjs';
import {recoveryDigest} from '../scripts/forward-host-recovery.mjs';
assert.equal(process.getuid(), 0); assert.equal(hostname(), 'lima-servora-r4-20261012');
const a = JSON.parse(readFileSync(PATHS.root + '/authorization.json'));
assert.equal(a.reason, 'SYNTHETIC_TARGETED_HOST_FIXTURE');
assert.equal(a.host.database.databaseName, 'servora_med_test_eh');
assert.equal(a.target.releaseSha, 'e'.repeat(40));
const io = await createHostIO(a); await io.check(); await io.verifyTarget(); await io.verifyBackups('post');
const journal = openHostJournal(PATHS.root + '/' + a.attemptId + '/journal');
let log = io.readLog(), state = validateHostLog(log, a, recoveryDigest(a), io.toolHash);
assert.equal(state.contract.phase, 'POSTDEPLOY_BACKUP_PASSED');
const start = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const end = new Date(Date.parse(start) + 1800_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const append = (event, data, contract = state.contract, atUTC = end) => {
  const record = seal({formatVersion: 1, kind: 'FORWARD_HOST_EVENT', sequence: log.length,
    previousHash: log.at(-1).hash, authorizationSha256: recoveryDigest(a), toolHash: io.toolHash,
    event, data, contract, atUTC});
  validateHostLog([...log, record], a, recoveryDigest(a), io.toolHash); journal.append(record);
  log = io.readLog(); state = validateHostLog(log, a, recoveryDigest(a), io.toolHash);
};
for (const phase of ['OBSERVATION_INTENT', 'OBSERVATION_STARTED'])
  append('PHASE', null, advanceForwardTransition(state.contract, phase, start), start);
const identity = await io.identity();
append('OBSERVE_INTENT', {anchor: state.contract.hash, identity}, state.contract, start);
append('OBSERVE_DONE', {kind: 'SYNTHETIC_TERMINAL_IO_FIXTURE_NOT_OBSERVATION'});
append('PHASE', null, recordForwardObservation(state.contract, {startedAtUTC: start, completedAtUTC: end,
  seconds: 1800, samples: 61, pid: identity.pid, pidStartTime: identity.startTime, bootId: identity.bootId,
  endPid: identity.pid, endStartTime: identity.startTime, endBootId: identity.bootId}, end));
append('POLICY_INTENT', {});
unlinkSync(PATHS.policy); flushDirectory('/etc/systemd/system/servora-med.service.d');
execFileSync('/usr/bin/systemctl', ['daemon-reload']);
append('POLICY_DONE', {restart: 'on-failure', startGate: 'CLOSED'});
append('PHASE', null, sealForwardAcceptance(state.contract, a, await io.context(), end));
process.stdout.write('SYNTHETIC_ACCEPTED_STATE_NOT_OBSERVATION\n');
