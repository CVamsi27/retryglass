import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createConnection, createServer as createNetServer } from 'node:net';
import { chmod, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { EffectLedger, type LedgerSnapshot, type ProviderProfile } from './ledger.js';

const Payload = z.object({ operationKey: z.string().regex(/^[a-z0-9-]{1,80}$/), recipient: z.string().min(1).max(128) }).strict();
const Control = z.object({ action: z.enum(['read', 'seal', 'resume']) }).strict();
const DEFAULT_SOCKET = '/tmp/retryglass-control.sock';

function reply(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Connection': 'close' });
  response.end(JSON.stringify(data));
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 65_536) throw new Error('Body exceeds 64 KiB');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export async function startSimulator(options: {
  port?: number; host?: string; socketPath?: string; profile: ProviderProfile;
}): Promise<{ url: string; close(): Promise<void> }> {
  const socketPath = options.socketPath ?? DEFAULT_SOCKET;
  const ledger = new EffectLedger(options.profile);
  let sealed = false;
  let active = 0;
  const server = createServer(async (request, response) => {
    if (sealed) { reply(response, 503, { error: 'intake sealed' }); return; }
    if (request.method !== 'POST' || request.url !== '/effects/email') {
      ledger.issue('Unmatched HTTP request');
      reply(response, 404, { error: 'unsupported endpoint' });
      return;
    }
    active += 1;
    try {
      const data = Payload.parse(await requestBody(request));
      const header = request.headers['idempotency-key'];
      if (Array.isArray(header) || (header !== undefined && (header.length > 128 || !/^[\x20-\x7e]+$/.test(header)))) {
        throw new Error('Invalid idempotency key');
      }
      const result = ledger.accept(data, header ?? null);
      if (result.loseResponse) {
        response.destroy();
      } else {
        reply(response, result.status, { operationId: result.operationId ?? null });
      }
    } catch {
      ledger.issue('Invalid or incomplete HTTP request');
      if (!response.destroyed) reply(response, 400, { error: 'invalid effect request' });
    } finally {
      active -= 1;
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.timeout = 5000;
  server.maxRequestsPerSocket = 1;
  const controller = createNetServer(socket => {
    let input = '';
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('data', chunk => {
      input += chunk.toString('utf8');
      if (input.length > 1024) { socket.destroy(); return; }
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      const line = input.slice(0, newline);
      input = '';
      void (async () => {
        try {
          const { action } = Control.parse(JSON.parse(line));
          if (action === 'resume') sealed = false;
          if (action === 'seal') {
            sealed = true;
            const deadline = performance.now() + 5000;
            while (active > 0 && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
            if (active > 0) {
              ledger.issue('Simulator handlers failed to drain');
              socket.end(JSON.stringify({ error: 'simulator drain timeout', ...ledger.snapshot() }) + '\n');
              return;
            }
          }
          socket.end(JSON.stringify({ ...ledger.snapshot(), sealed, active }) + '\n');
        } catch {
          socket.end(JSON.stringify({ error: 'invalid control request' }) + '\n');
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => { controller.once('error', reject); controller.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 4010, options.host ?? '0.0.0.0', resolve); });
  } catch (error) {
    await new Promise<void>(resolve => controller.close(() => resolve()));
    await rm(socketPath, { force: true });
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP listener address unavailable');
  return {
    url: `http://${options.host ?? '127.0.0.1'}:${address.port}`,
    async close() {
      sealed = true;
      server.closeAllConnections();
      await Promise.all([
        new Promise<void>(resolve => server.close(() => resolve())),
        new Promise<void>(resolve => controller.close(() => resolve())),
      ]);
      await rm(socketPath, { force: true });
    },
  };
}

export async function controlSimulator(socketPath: string, action: 'read' | 'seal' | 'resume'): Promise<LedgerSnapshot & { sealed?: boolean; active?: number }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let input = '';
    socket.setTimeout(7000, () => { socket.destroy(); reject(new Error('Simulator control timeout')); });
    socket.once('error', reject);
    socket.once('connect', () => socket.write(JSON.stringify({ action }) + '\n'));
    socket.on('data', chunk => {
      input += chunk.toString('utf8');
      if (Buffer.byteLength(input) > 1_048_576) { socket.destroy(); reject(new Error('Simulator journal exceeded bound')); return; }
      if (!input.includes('\n')) return;
      socket.end();
      try {
        const value = JSON.parse(input.slice(0, input.indexOf('\n')));
        if (value.error) reject(new Error(String(value.error)));
        else resolve(value);
      } catch (error) { reject(error); }
    });
    socket.once('end', () => { if (!input.includes('\n')) reject(new Error('Incomplete simulator control response')); });
  });
}

async function main(): Promise<void> {
  if (process.argv[2] === 'control') {
    const { action } = Control.parse({ action: process.argv[3] });
    process.stdout.write(JSON.stringify(await controlSimulator(process.env.SIMULATOR_SOCKET ?? DEFAULT_SOCKET, action)) + '\n');
    return;
  }
  const running = await startSimulator({
    port: 4010, socketPath: process.env.SIMULATOR_SOCKET ?? DEFAULT_SOCKET,
    profile: { idempotent: process.env.SIMULATOR_IDEMPOTENT !== 'false', loseFirstAcknowledgement: process.env.SIMULATOR_LOSE_FIRST_ACK !== 'false' },
  });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => void running.close().then(() => process.exit(0)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write('Simulator failed\n'); process.exitCode = 1; });
}
