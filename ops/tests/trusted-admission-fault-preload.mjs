// Test-only syscall fault injection. Never imported by production entrypoints.
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {hostname} from 'node:os';
if(process.getuid()!==0 || hostname()!=='lima-servora-tt-a-amd64-20261026')throw new Error('DISPOSABLE_HOST_REQUIRED');
const original=fs.fsyncSync;
fs.fsyncSync=function(fd) {
  const path=fs.readlinkSync('/proc/self/fd/'+fd),fault=process.env.TT_A_PUBLICATION_FAULT;
  if((fault==='proof-file-error' && /\/admission-proofs\/\.admission-.*\.tmp$/.test(path))
    || (fault==='proof-directory-error' && path==='/var/lib/servora-med/deploy/admission-proofs')) {
    throw Object.assign(new Error('INJECTED_FSYNC_EIO'),{code:'EIO'});
  }
  const result=original(fd);
  if(fault==='marker-stop' && path==='/var/lib/servora-med/deploy/initializations') {
    fs.writeSync(1,'FAULT_READY=marker-stop\n');process.kill(process.pid,'SIGSTOP');
  }
  return result;
};
syncBuiltinESMExports();
