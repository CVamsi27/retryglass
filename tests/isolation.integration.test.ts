import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { createCell, destroyCell, prepareImages, startWorker, waitForContainerCleanup, waitForNetworkCleanup } from '../src/docker/lifecycle.js';
import { loadScenario } from '../src/scenario.js';

const exec = promisify(execFile);
async function client(args: string[]) {
  const env = { ...process.env };
  if (env.RETRYGLASS_CONTAINER_HOST) { env.DOCKER_HOST = env.RETRYGLASS_CONTAINER_HOST; delete env.DOCKER_CONTEXT; }
  return (await exec(env.RETRYGLASS_CONTAINER_CLI ?? 'docker', args, { env, timeout: 15_000, maxBuffer: 1024 * 1024 })).stdout.trim();
}

test('the real worker cannot reach a host canary and has no host resources or default route', async () => {
  await prepareImages();
  let connections = 0;
  const canary = createServer(socket => { connections++; socket.end(); });
  await new Promise<void>(resolve => canary.listen(0, '0.0.0.0', resolve));
  const port = (canary.address() as { port: number }).port;
  const root = await mkdtemp(join(tmpdir(), 'retryglass-isolation-'));
  const runId = `isolation-${Date.now().toString(36)}`;
  const { scenario, fixtureRoot } = await loadScenario(resolve('examples/invoice/scenario.json'));
  const sentinel = process.env.RETRYGLASS_HOST_SENTINEL;
  process.env.RETRYGLASS_HOST_SENTINEL = 'synthetic-host-only';
  let cell: Awaited<ReturnType<typeof createCell>> | undefined;
  try {
    cell = await createCell(scenario, fixtureRoot, root, runId);
    await startWorker(cell, scenario);
    const [inspect] = JSON.parse(await client(['inspect', cell.workerContainerId!]));
    expect(inspect.Config.User).toBe('10001:10001');
    expect(inspect.HostConfig.ReadonlyRootfs).toBe(true);
    expect(inspect.HostConfig.Privileged).toBe(false);
    expect(inspect.HostConfig.CapDrop).toContain('ALL');
    expect(inspect.HostConfig.Binds ?? []).toEqual([]);
    expect(inspect.Mounts).toEqual([]);
    expect(inspect.HostConfig.PortBindings ?? {}).toEqual({});
    expect(inspect.Config.Env.join('\n')).not.toContain('RETRYGLASS_HOST_SENTINEL');
    expect(inspect.Config.Env.join('\n')).not.toMatch(/DOCKER_HOST|DOCKER_CONTEXT|RETRYGLASS_CONTAINER_/);
    const probe = String.raw`
      const fs=require('node:fs'),net=require('node:net');
      const routes=fs.readFileSync('/proc/net/route','utf8').trim().split('\n').slice(1).map(line=>line.trim().split(/\s+/));
      if(routes.some(row=>row[1]==='00000000'))throw Error('Default route present');
      for(const path of ['/var/run/docker.sock','/run/docker.sock'])if(fs.existsSync(path))throw Error('Engine socket exposed');
      Promise.all(['host.docker.internal','host.orb.internal'].map(host=>new Promise(resolve=>{
        const socket=net.connect({host,port:PORT});let done=false;
        const finish=reachable=>{if(done)return;done=true;socket.destroy();resolve({host,reachable});};
        socket.setTimeout(1200,()=>finish(false));socket.on('connect',()=>finish(true));socket.on('error',()=>finish(false));
      }))).then(results=>{console.log(JSON.stringify(results));if(results.some(result=>result.reachable))process.exitCode=1;});
    `.replace('PORT', String(port));
    const observations = JSON.parse(await client(['exec', cell.workerContainerId!, 'node', '-e', probe]));
    expect(observations).toHaveLength(2);
    expect(observations.every((value: { reachable: boolean }) => !value.reachable)).toBe(true);
    expect(connections).toBe(0);
  } finally {
    if (sentinel === undefined) delete process.env.RETRYGLASS_HOST_SENTINEL; else process.env.RETRYGLASS_HOST_SENTINEL = sentinel;
    if (cell) await destroyCell(cell);
    await new Promise<void>((resolve, reject) => canary.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
    await waitForContainerCleanup(runId);
    await waitForNetworkCleanup(runId);
  }
}, 180_000);
