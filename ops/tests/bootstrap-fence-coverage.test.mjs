// Inventory drift checks supplement the executable Linux tests; they are not
// evidence for effective production sudoers, systemd, Chrony or reboot policy.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const scripts = new URL('../scripts/', import.meta.url);
const read = name => readFileSync(new URL(name, scripts), 'utf8');

test('the fixed shell guard pins the exact reviewed module and offers no write or bypass command', () => {
  const module = read('bootstrap-fence.mjs'), wrapper = read('bootstrap-fence.sh');
  const sha = createHash('sha256').update(module).digest('hex');
  assert.ok(wrapper.includes('== ' + sha + ' ]]'), 'update the module pin after every guard source change');
  assert.doesNotMatch(module, /(?:writeFileSync|unlinkSync|renameSync|mkdirSync)\(/);
  assert.doesNotMatch(wrapper, /(?:chmod|chown|mkdir|rm|touch) /);
  assert.match(wrapper, /unset NODE_OPTIONS NODE_PATH BASH_ENV ENV/);
});

test('every supported orchestration CLI has an explicit fence boundary', () => {
  const sources = [
    ['deploy-production-host.sh', 'bootstrap_management_guard'],
    ['deployment-controller.mjs', "assertBootstrapManagementAllowed('controller', attemptId)"],
    ['forward-host.mjs', "assertBootstrapManagementAllowed('forward'"],
    ['emergency-handoff-host.mjs', "assertBootstrapManagementAllowed('emergency-handoff')"],
    ['issue-emergency-handoff.mjs', "assertBootstrapManagementAllowed('emergency-handoff')"],
    ['preserve-forward-authorization.mjs', "withBootstrapMutationLock('preserve-authorization'"],
    ['issue-installed-old-adoption.sh', 'bootstrap-fence adoption'],
    ['issue-installed-old-adoption-67d3318.sh', 'bootstrap-fence adoption'],
    ['deploy-release.sh', 'bootstrap-fence legacy-deploy'],
    ['production-recovery.sh', 'bootstrap-fence legacy-restore'],
  ];
  for (const [file, boundary] of sources) assert.ok(read(file).includes(boundary), file);
  const attestation=readFileSync(new URL('../recovery-tools/attest-installed-old-cutover-67d3318',import.meta.url),'utf8');
  assert.ok(attestation.includes('bootstrap-fence adoption'));
  const helper = read('deploy-production-host.sh');
  assert.ok(helper.lastIndexOf('bootstrap_management_guard') < helper.lastIndexOf('deploy_phase\n'));
  assert.ok(helper.includes('esac\nbootstrap_management_guard\n'), 'recheck while host.lock is held');
});

test('forward and emergency tool manifests include the new import dependency', () => {
  assert.match(read('forward-host.mjs'), /'bootstrap-fence.mjs', 'required-checks.txt'/);
  assert.match(read('emergency-handoff-artifact.mjs'), /path: 'bootstrap-fence.mjs', mode: 0o644/);
});

test('application runtime, collector and scheduled backup do not consume the management fence', () => {
  for (const file of ['backup-postgres.sh', 'predeploy-backup-launcher.sh', 'backup-observation.mjs', 'trusted-time.mjs']) {
    assert.doesNotMatch(read(file), /bootstrap-fence/);
  }
  for (const name of ['servora-med.service', 'servora-med-backup.service', 'servora-med-backup.timer',
    'servora-med-backup-worker.service', 'servora-med-time-evidence@.service']) {
    const unit = readFileSync(new URL('../systemd/' + name, import.meta.url), 'utf8');
    assert.doesNotMatch(unit, /bootstrap-fence/);
  }
  const scheduled = readFileSync(new URL('../systemd/servora-med-backup.service', import.meta.url), 'utf8');
  assert.match(scheduled, /backup-postgres.sh --trigger=scheduled/);
});
