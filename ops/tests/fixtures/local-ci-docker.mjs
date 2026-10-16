// Stateful Docker CLI fixture. Models both the old runner and create/start/rm -v.
// It never contacts Docker. Every invocation is recorded for boundary assertions.
import fs from 'node:fs';
const file = process.env.CI_FIXTURE_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
let args = process.argv.slice(2);
fs.appendFileSync(file + '.calls', JSON.stringify({ args, host: process.env.DOCKER_HOST, context: process.env.DOCKER_CONTEXT }) + '\n');
if (args[0] === '--host' || args[0] === '--context') args = args.slice(2);
const done = (code = 0, output = '') => {
  fs.writeFileSync(file, JSON.stringify(state));
  if (output) process.stdout.write(output + '\n');
  process.exit(code);
};
const option = (flag) => args[args.indexOf(flag) + 1];
const labels = () => Object.fromEntries(args.flatMap((arg, i) => arg === '--label' ? [args[i + 1].split(/=(.*)/s).slice(0, 2)] : []));
const owns = (resource, name) => resource && [resource.id, resource.name].includes(name);
if (args.join(' ') === 'context show') done(0, process.env.DOCKER_CONTEXT || state.context || 'colima-true');
if (args.slice(0, 2).join(' ') === 'context inspect') done(0, 'unix:///fixture/docker.sock');
if (args[0] === 'info') {
  state.infoCalls = (state.infoCalls || 0) + 1;
  done(0, state.failure === 'daemon-change' && state.infoCalls > 1 ? 'different-daemon' : state.daemon || 'fixture-daemon');
}
if (args.slice(0, 2).join(' ') === 'network create') {
  state.network = { id: 'a'.repeat(64), name: args.at(-1), labels: labels() };
  if (state.foreignLabel) state.network.labels['com.servora.local-ci.run'] = 'foreign-run';
  done(state.failure === 'partial-network' ? 125 : 0, state.network.id);
}
if (args[0] === 'create' || (args[0] === 'run' && args.includes('-d'))) {
  state.container = { id: 'b'.repeat(64), name: option('--name'), labels: labels() };
  if (state.foreignLabel) state.container.labels['com.servora.local-ci.run'] = 'foreign-run';
  state.volumes.anonymous = true;
  done((['partial-container', 'start'].includes(state.failure) && args[0] === 'run') || state.failure === 'partial-container' ? 125 : 0, state.container.id);
}
if (args[0] === 'start') {
  state.started = true;
  done(state.failure === 'start' ? 125 : 0, state.container.id);
}
if (args[0] === 'run') done(0, 'psql (PostgreSQL) 17.11');
if (args[0] === 'inspect' || args[1] === 'inspect') {
  const format = option('--format') || option('-f');
  if (format.includes('.Mounts')) {
    if (state.failure === 'inspect') done(1);
    done(0, Object.keys(state.volumes).filter((v) => state.volumes[v]).join(' '));
  }
  if (args[0] === 'volume') done(0, state.namedLabels || 'null');
  const kind = args[0] === 'network' ? 'network' : 'container';
  const resource = state[kind];
  if (process.env.CI_FIXTURE_INSPECT_FAIL === 'true' || state.failure === 'ownership-inspect' || !owns(resource, args.at(-1))) done(1);
  done(0, `${resource.id} ${resource.labels['com.servora.local-ci.run'] || '<no value>'}`);
}
if (args[0] === 'rm') {
  if (state.failure === 'cleanup') { process.stderr.write('fixture removal denied\n'); done(7); }
  if (!owns(state.container, args.at(-1))) done(1);
  state.container = null;
  if (args.includes('-fv') || args.includes('-vf') || args.includes('-v') || args.includes('--volumes')) {
    if (!state.sharedAnonymous) state.volumes.anonymous = false;
  }
  done();
}
if (args.slice(0, 2).join(' ') === 'volume rm') {
  state.volumes[args.at(-1)] = false;
  done();
}
if (args.slice(0, 2).join(' ') === 'network rm') {
  if (state.container || !owns(state.network, args.at(-1))) done(1);
  state.network = null;
  done();
}
process.stderr.write('unexpected fixture command: ' + args.join(' ') + '\n');
done(99);
