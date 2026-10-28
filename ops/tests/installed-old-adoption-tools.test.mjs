// Real GNU tar / PostgreSQL 17 tools, synthetic isolated DB, mocked host paths.
// No production data, profile, service or approval is used.
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,chmodSync,rmSync,cpSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {adoptionHost,adoptionFixture} from './installed-old-adoption-fixture.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const enabled=Boolean(process.env.TEST_DATABASE_URL)||process.env.CI==='true';
test('real archive and dump tools independently verify the adopted recovery payload',
  {skip:enabled?false:'TEST_DATABASE_URL not provisioned; real tools test NOT_RUN'},async t=>{
    const url=new URL(process.env.TEST_DATABASE_URL);
    const ci=process.env.CI==='true'&&['servora-localci-pg','127.0.0.1','localhost','[::1]'].includes(url.hostname)
      &&url.pathname==='/servora_med_test';
    const local=['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&/^\/servora_med_test_[a-z0-9_]+$/.test(url.pathname);
    assert.ok(['postgres:','postgresql:'].includes(url.protocol)&&(ci||local)&&url.username&&url.password&&!url.search&&!url.hash,
      'explicit isolated test database required');
    const psql=process.env.PSQL_BIN??'psql',dump=process.env.PG_DUMP_BIN??'pg_dump',restore=process.env.PG_RESTORE_BIN??'pg_restore';
    const tar=process.env.TAR_BIN??'/usr/bin/tar';
    for(const tool of [psql,dump,restore])assert.match(execFileSync(tool,['--version'],{encoding:'utf8'}),/\b17\./);
    assert.match(execFileSync(tar,['--version'],{encoding:'utf8'}),/GNU tar/);
    const pgEnv={PATH:process.env.PATH,PGHOST:url.hostname,PGPORT:url.port||'5432',
      PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),PGDATABASE:url.pathname.slice(1)};
    const sql=(text,database=pgEnv.PGDATABASE)=>execFileSync(psql,['-X','--no-psqlrc','--set=ON_ERROR_STOP=1','--tuples-only','--no-align'],
      {input:text,encoding:'utf8',env:{...pgEnv,PGDATABASE:database},timeout:15000,maxBuffer:1048576});
    assert.equal(Math.floor(Number(sql("SELECT current_setting('server_version_num');"))/10000),17);
    const db='servora_med_test_adoption_'+randomUUID().replaceAll('-','');
    assert.match(db,/^servora_med_test_adoption_[a-f0-9]{32}$/);
    const temporary=mkdtempSync(join(tmpdir(),'servora-adoption-tools-'));
    let databaseCreated=false;
    t.after(()=>{try{if(databaseCreated)sql('DROP DATABASE '+db+';');}finally{rmSync(temporary,{recursive:true});}});
    sql('CREATE DATABASE '+db+';');databaseCreated=true;
    const catalog=adoptionFixture().context.approval.oldCatalog;
    assert.ok(catalog.every(entry=>/^[0-9]{3}_[a-z0-9_]+$/.test(entry.version)));
    sql('CREATE TABLE public.schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());\n'
      +'INSERT INTO public.schema_migrations (version) VALUES '+catalog.map(e=>"('"+e.version+"')").join(',')+';',db);
    const goodDump=join(temporary,'good.dump');
    const makeDump=path=>{execFileSync(dump,['-Fc','--no-owner','--no-acl','--file',path],
      {env:{...pgEnv,PGDATABASE:db},timeout:15000,stdio:['ignore','pipe','pipe']});chmodSync(path,0o600);};
    makeDump(goodDump);
    let sequence=0;
    async function prepare(dumpPath,badArchive=false) {
      const f=adoptionFixture(),host=await adoptionHost(f);t.after(host.cleanup);
      const directory=join(temporary,String(sequence++)),release=join(directory,'release');
      mkdirSync(release,{recursive:true,mode:0o700});
      for(const [path,file] of host.files)if(path.startsWith(host.root+'/')){
        const destination=join(release,path.slice(host.root.length+1));mkdirSync(dirname(destination),{recursive:true,mode:0o755});
        writeFileSync(destination,file.data,{mode:file.mode});
      }
      const archive=join(directory,'adopted.tar.gz');let source=release;
      if(badArchive){source=join(directory,'drift');cpSync(release,source,{recursive:true});writeFileSync(join(source,'payload'),'different bytes');}
      execFileSync(tar,['--create','--gzip','--file',archive,'--directory',source,'.']);chmodSync(archive,0o600);
      const baselineRoot='/var/lib/servora-med-recovery-baselines/'+f.baseline.baselineId;
      for(const [name,path] of [['database.dump',dumpPath],['installed-old-release.adopted.tar.gz',archive]]){
        const bytes=readFileSync(path);host.add(baselineRoot+'/'+name,bytes);
        f.baseline.files[name]={name,bytes:bytes.length,sha256:hash(bytes)};
      }
      host.add(baselineRoot+'/baseline-manifest.json',JSON.stringify(f.baseline)+'\n');
      const paths=new Map([[host.root,release],[baselineRoot+'/database.dump',dumpPath],
        [baselineRoot+'/installed-old-release.adopted.tar.gz',archive]]);
      host.realTools=(file,args,options)=>execFileSync(file==='/usr/bin/tar'?tar:restore,args.map(arg=>paths.get(arg)??arg),options);
      return {f,host};
    }
    await t.test('valid synthetic archive plus 055 dump passes the actual controller with real tools',async()=>{
      const {f,host}=await prepare(goodDump);
      const sealed=host.controller.issueInstalledOldAdoption(f.context.approval.attemptId,f.baseline.baselineId);
      assert.equal(sealed.record.databaseDumpSha256,hash(readFileSync(goodDump)));
      assert.doesNotThrow(()=>host.controller.verifyAttemptRelease(f.context.approval.attemptId,'old'));
      assert.ok(host.commands.some(([file,...args])=>file==='/usr/bin/pg_restore'&&args.includes('--table=schema_migrations')));
    });
    await t.test('a fully rehashed archive with different payload bytes is refused by real tar compare',async()=>{
      const {f,host}=await prepare(goodDump,true);
      assert.throws(()=>host.controller.issueInstalledOldAdoption(f.context.approval.attemptId,f.baseline.baselineId));
      assert.equal(host.files.has(host.recordFile),false);
    });
    await t.test('a readable, rehashed dump with a missing migration is refused by the real ledger reader',async()=>{
      sql("DELETE FROM public.schema_migrations WHERE version='"+catalog.at(-1).version+"';",db);
      const badDump=join(temporary,'bad.dump');makeDump(badDump);
      const {f,host}=await prepare(badDump);
      assert.throws(()=>host.controller.issueInstalledOldAdoption(f.context.approval.attemptId,f.baseline.baselineId),
        /RECOVERY_BASELINE_DUMP_CATALOG_MISMATCH/);
      assert.equal(host.files.has(host.recordFile),false);
    });
  });
