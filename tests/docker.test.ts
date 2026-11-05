import { afterEach, expect, test } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, chmod, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createCell, startWorker, stopWorker, destroyCell, execCollector, simulatorControl, stageImageBuildContext } from '../src/docker/lifecycle.js';
import type { Cell, Scenario } from '../src/contracts.js';

const temporary: string[] = [];
const originalExecutable = process.env.RETRYGLASS_CONTAINER_CLI;
const originalHost = process.env.RETRYGLASS_CONTAINER_HOST;
afterEach(async () => {
  if (originalExecutable === undefined) delete process.env.RETRYGLASS_CONTAINER_CLI; else process.env.RETRYGLASS_CONTAINER_CLI = originalExecutable;
  if (originalHost === undefined) delete process.env.RETRYGLASS_CONTAINER_HOST; else process.env.RETRYGLASS_CONTAINER_HOST = originalHost;
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fakeDocker(options: { foreign?: string; malformedLedger?: boolean; malformedCollector?: boolean; state?: Record<string, unknown>; failRemove?: string; failWorkerStart?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'retryglass-docker-test-'));
  temporary.push(directory);
  const log = join(directory, 'calls.jsonl');
  await writeFile(log, '');
  const script = '#!' + process.execPath + '\n' + String.raw`
const fs = require('node:fs');
const args = process.argv.slice(2);
let input='';
process.stdin.on('data', chunk=>input+=chunk);
process.stdin.on('end', ()=>{
 const options=OPTIONS;
 fs.appendFileSync(LOG,JSON.stringify({args,input,host:process.env.DOCKER_HOST})+'\n');
 const out=value=>process.stdout.write((typeof value==='string'?value:JSON.stringify(value))+'\n');
 if(args[0]==='image') return out('sha256:'+'a'.repeat(64));
 if(args[0]==='inspect'||(args[0]==='network'&&args[1]==='inspect')) {
   if(args.some(arg=>arg.includes('.State'))) return out(options.state||{Running:false,ExitCode:137,OOMKilled:false});
   const resource=args.at(-1);
   return out({'com.retryglass.owner':'retryglass','com.retryglass.run':resource===options.foreign?'foreign-run':'test-run1'});
 }
 if(args[0]==='run') { if(options.failWorkerStart&&args.includes('dist/src/runtime/worker-entry.js')) {process.stderr.write('client lost acknowledgement');process.exitCode=1;return;} return out('abcdef012345'); }
 if(args[0]==='exec') {
   const command=args.at(-1);
   if(command==='ping') return out('PONG');
   if(command==='pg_isready'||args.includes('pg_isready')) return out('ready');
   if(args.includes('collector-entry.js')||args.includes('dist/src/runtime/collector-entry.js')) {
      if(options.malformedCollector)return out({});
      const argument=JSON.parse(input||'null');
      if(command==='probe')return out({reachable:true,...argument});
      if(command==='snapshot')return out(argument.tables.map(table=>({...table,rows:[],truncated:false})));
      if(command==='quiesce')return out({terminatedActive:false,remaining:0});
      if(command==='resume-db')return out({resumed:true,role:argument.role});
      if(command==='job-state')return out({exists:true,jobId:argument.jobId,operationKey:'op-17',state:'failed',attemptsMade:1,attemptsStarted:1});
   }
   if(args.includes('dist/src/http/simulator.js')) {
     if(options.malformedLedger)return out({sealed:true,active:0});
     return out({httpAttempts:[],appliedOperations:[],issues:[],sealed:command!=='resume',active:0});
   }
   return out('');
 }
 if(args[0]==='rm'&&args.includes(options.failRemove)){process.stderr.write('remove failed');process.exitCode=1;return;}
 return out('ok');
});
`.replace('OPTIONS', JSON.stringify(options)).replace('LOG', JSON.stringify(log));
  const executable = join(directory, 'container-client');
  await writeFile(executable, script); await chmod(executable, 0o755);
  process.env.RETRYGLASS_CONTAINER_CLI = executable;
  return async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as {args:string[];input:string;host?:string});
}

const cell = (): Cell => ({runId:'test-run1',projectName:'retryglass-test-run1',runDir:'/tmp/fixture',collectorContainerId:'collector-id',postgresContainerId:'postgres-id',redisContainerId:'redis-id',simulatorContainerId:'simulator-id',networkId:'network-id',applicationRole:'rg_fixture',applicationPassword:'synthetic-app',redisPassword:'synthetic-redis',toolImage:'retryglass-tool:0.1.0-alpha.1'});
const workerScenario = {worker:{image:'retryglass-tool:0.1.0-alpha.1',processor:'dist/examples/invoice/corrected.js'}} as Scenario;

test('worker uses its internal cell and immutable image, without host resources', async () => {
  const calls = await fakeDocker();
  process.env.RETRYGLASS_CONTAINER_HOST = 'unix:///synthetic/orbstack.sock';
  const active = cell();
  await startWorker(active,workerScenario,null,{crashAfter:3});
  const call = (await calls()).find(item=>item.args[0]==='run')!;
  expect(call.host).toBe('unix:///synthetic/orbstack.sock');
  for(const expected of ['--init','--read-only','no-new-privileges','--cap-drop','ALL','--pids-limit','--memory','--cpus','network-id','CRASH_AFTER=3',`sha256:${'a'.repeat(64)}`])expect(call.args).toContain(expected);
  for(const forbidden of ['--privileged','--publish','-p','--volume','-v','--mount','--add-host','bridge','host'])expect(call.args).not.toContain(forbidden);
  expect(call.args).toContain('com.retryglass.owner=retryglass');
  expect(active.workerContainerId).toBe('abcdef012345');
});

test('cleanup refuses foreign ownership while still attempting other owned resources', async () => {
  const calls = await fakeDocker({foreign:'postgres-id'});
  await expect(destroyCell(cell())).rejects.toThrow(/ownership/i);
  const removed=(await calls()).filter(item=>item.args[0]==='rm').flatMap(item=>item.args.slice(2));
  expect(removed).not.toContain('postgres-id');
  expect(removed).toContain('collector-id');
});

test('cleanup attempts the owned network and all resources when one removal fails',async()=>{
  const calls=await fakeDocker({failRemove:'postgres-id'});
  await expect(destroyCell(cell())).rejects.toThrow(/cleanup/i);
  const observed=await calls();
  expect(observed.some(item=>item.args[0]==='network'&&item.args[1]==='rm')).toBe(true);
  expect(observed.some(item=>item.args[0]==='rm'&&item.args.includes('redis-id'))).toBe(true);
});

test('collector data is passed on stdin and missing observations are rejected',async()=>{
  const calls=await fakeDocker();
  const result=await execCollector(cell(),'job-state',{jobId:'job-17'});
  expect(result).toMatchObject({jobId:'job-17',state:'failed'});
  const observed=(await calls()).find(item=>item.args[0]==='exec')!;
  expect(JSON.parse(observed.input)).toEqual({jobId:'job-17'});
  await expect(execCollector(cell(),'sh',{})).rejects.toThrow(/unsupported/i);
  await fakeDocker({malformedCollector:true});
  await expect(execCollector(cell(),'job-state',{jobId:'job-17'})).rejects.toThrow(/observation|collector/i);
});

test('a malformed simulator ledger cannot become empty passing evidence',async()=>{
  await fakeDocker();
  expect(await simulatorControl(cell(),'seal')).toMatchObject({httpAttempts:[],appliedOperations:[],sealed:true});
  await fakeDocker({malformedLedger:true});
  await expect(simulatorControl(cell(),'seal')).rejects.toThrow(/ledger|simulator/i);
});

test('stop records an already exited worker OOM separately from a supervisor kill',async()=>{
  await fakeDocker({state:{Running:false,ExitCode:137,OOMKilled:true}});
  const active={...cell(),workerContainerId:'worker-id'};
  const result=await stopWorker(active,'SIGTERM');
  expect(result).toMatchObject({code:137,oomKilled:true,forced:false});
  expect(active.workerContainerId).toBeUndefined();
});

test('cell creation reads contained SQL contents, creates an internal network, and starts no application worker',async()=>{
  const calls=await fakeDocker();
  const directory=await mkdtemp(join(tmpdir(),'retryglass-cell-fixture-'));temporary.push(directory);
  await writeFile(join(directory,'schema.sql'),'CREATE TABLE synthetic(id integer);');
  await writeFile(join(directory,'seed.sql'),'INSERT INTO synthetic VALUES (17);');
  const scenario={...workerScenario,fixture:{schema:'schema.sql',seed:'seed.sql',expectedRows:{}},job:{name:'invoice',id:'job-17'},provider:{idempotent:true,loseFirstAcknowledgement:false}} as Scenario;
  const created=await createCell(scenario,directory,directory,'test-run1');
  const observed=await calls();
  expect(observed.find(item=>item.args[0]==='network'&&item.args[1]==='create')?.args).toContain('--internal');
  expect(observed.find(item=>item.args[0]==='network'&&item.args[1]==='create')?.args).toContain('com.docker.network.bridge.gateway_mode_ipv4=isolated');
  expect(observed.some(item=>item.input==='CREATE TABLE synthetic(id integer);')).toBe(true);
  expect(observed.some(item=>item.input==='INSERT INTO synthetic VALUES (17);')).toBe(true);
  expect(observed.some(item=>item.args.includes('dist/src/runtime/worker-entry.js'))).toBe(false);
  expect(created.workerContainerId).toBeUndefined();
  expect(observed.some(item=>item.args.includes('COLLECTOR_DATABASE_URL'))).toBe(false);
  expect(observed.some(item=>item.args.some(arg=>arg.startsWith('COLLECTOR_DATABASE_URL=')))).toBe(true);
});

test('staged image context contains runtime closure without hoisted or pnpm source links',async()=>{
  const root=await mkdtemp(join(tmpdir(),'retryglass-stage-fixture-'));temporary.push(root);
  await mkdir(join(root,'dist'),{recursive:true});await mkdir(join(root,'examples'),{recursive:true});await mkdir(join(root,'templates'),{recursive:true});
  await writeFile(join(root,'package.json'),JSON.stringify({name:'retryglass',dependencies:{'runtime-a':'1.0.0'}}));
  await writeFile(join(root,'dist','entry.js'),'export const synthetic = true;');
  await writeFile(join(root,'templates','collector.Dockerfile'),'FROM synthetic');
  const source=join(root,'.store','runtime-a');await mkdir(source,{recursive:true});
  await writeFile(join(source,'package.json'),JSON.stringify({name:'runtime-a',version:'1.0.0',main:'index.js'}));await writeFile(join(source,'index.js'),'module.exports=17;');
  await mkdir(join(root,'node_modules'),{recursive:true});await symlink('../.store/runtime-a',join(root,'node_modules','runtime-a'));
  const staged=await stageImageBuildContext(root);
  try {
    await rm(join(root,'.store'),{recursive:true,force:true});
    expect(await readFile(join(staged.root,'node_modules','runtime-a','index.js'),'utf8')).toBe('module.exports=17;');
    expect(await readFile(join(staged.root,'dist','entry.js'),'utf8')).toContain('synthetic');
  }finally{await staged.cleanup();}
});

test('a worker startup acknowledgement failure keeps its scoped name available for cleanup',async()=>{
  const calls=await fakeDocker({failWorkerStart:true});
  const active=cell();
  await expect(startWorker(active,workerScenario)).rejects.toThrow();
  expect(active.workerContainerId).toBe('retryglass-test-run1-worker');
  await destroyCell(active);
  expect((await calls()).some(item=>item.args[0]==='rm'&&item.args.includes('retryglass-test-run1-worker'))).toBe(true);
});
