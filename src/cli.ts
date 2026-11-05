#!/usr/bin/env node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { exportCrashPoint, exportFixture } from './export.js';
import { controlSimulator, startSimulator } from './http/simulator.js';
import { exitCode } from './policy.js';
import { renderMarkdown, renderSweepMarkdown } from './report.js';
import { runScenario } from './run.js';
import { runSweep } from './sweep/run.js';
import { validateReport, validateSweepReport, type RunReport, type SweepReport } from './contracts.js';
import { initializeStarter } from './init.js';
import { inspectPrerequisites, validateScenarioFile } from './preflight.js';
import { PACKAGE_ROOT } from './package-root.js';

type AnyReport = RunReport | SweepReport;

export async function runDemo(): Promise<RunReport> {
  const directory = await mkdtemp(join(tmpdir(), 'retryglass-demo-'));
  const socketPath = join(directory, 'control.sock');
  let server: Awaited<ReturnType<typeof startSimulator>> | undefined;
  let cleanup: RunReport['cleanup'] = 'failed';
  try {
    server = await startSimulator({
      host: '127.0.0.1', port: 0, socketPath,
      profile: { idempotent: true, loseFirstAcknowledgement: true },
    });
    const payload = { operationKey: 'demo-op-1', recipient: 'example@retryglass.invalid' };
    const send = () => fetch(`${server!.url}/effects/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'demo-op-1' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2_000),
    });
    let acknowledgementLost = false;
    try { await send(); }
    catch { acknowledgementLost = true; }
    if (!acknowledgementLost) throw new Error('Demo expected the simulator to lose its first acknowledgement');
    const retry = await send();
    if (!retry.ok) throw new Error(`Demo retry returned HTTP ${retry.status}`);
    await controlSimulator(socketPath, 'seal');
    const evidence = await controlSimulator(socketPath, 'read');
    const report = validateReport({
      schemaVersion: 1,
      runId: 'local-demo',
      scenarioId: 'ambiguous-provider-ack',
      evidenceKind: 'synthetic',
      execution: 'completed',
      coverage: 'partial',
      assertions: 'not_evaluated',
      cleanup: 'completed',
      evidence: {
        before: [], partial: [], after: [],
        httpAttempts: evidence.httpAttempts,
        appliedOperations: evidence.appliedOperations,
        outputJobs: [], jobAttempts: [],
      },
      rules: [],
      missing: [
        'PostgreSQL projection was not included in this demo',
        'BullMQ job state and retry were not included in this demo',
      ],
      provenance: { runner: 'Retryglass local simulator demo', providerProfile: 'idempotent; first accepted acknowledgement lost' },
    });
    cleanup = 'completed';
    return report;
  } finally {
    try { if (server) await server.close(); } catch { cleanup = 'failed'; }
    try { await rm(directory, { recursive: true, force: true }); } catch { cleanup = 'failed'; }
    if (cleanup !== 'completed') throw new Error('Retryglass demo cleanup failed');
  }
}

const USAGE = 'Usage: retryglass <init | validate | doctor | sweep | run | inspect | export | demo> [options]';
const HELP: Record<string, string> = {
  init: 'Usage: retryglass init --target <new-directory> [--json]',
  validate: 'Usage: retryglass validate --scenario <path> [--json]',
  doctor: 'Usage: retryglass doctor [--scenario <path>] [--json]',
  run: 'Usage: retryglass run --scenario <path> [--output-root <dir>] [--json]',
  sweep: 'Usage: retryglass sweep --scenario <path> [--output-root <dir>] [--max-crash-points <n>] [--discovery-runs <n>] [--crash-point <id>] [--json]',
  inspect: 'Usage: retryglass inspect --report <path> [--json]',
  export: 'Usage: retryglass export --run <run-id> --target <dir> [--crash-point <id>] [--output-root <dir>] [--json]',
  demo: 'Usage: retryglass demo [--json]',
};

type Options = NonNullable<ParseArgsConfig['options']>;
function commandOptions(command: string): Options {
  const common: Options = { json: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false } };
  const strings = (...names: string[]) => Object.fromEntries(names.map(name => [name, { type: 'string' as const }]));
  switch (command) {
    case 'init': return { ...common, ...strings('target') };
    case 'validate': case 'doctor': return { ...common, ...strings('scenario') };
    case 'run': return { ...common, ...strings('scenario', 'output-root') };
    case 'sweep': return { ...common, ...strings('scenario', 'output-root', 'max-crash-points', 'discovery-runs'), 'crash-point': { type: 'string', multiple: true } };
    case 'inspect': return { ...common, ...strings('report') };
    case 'export': return { ...common, ...strings('run', 'target', 'crash-point', 'output-root') };
    case 'demo': return common;
    default: throw new Error(USAGE);
  }
}

function stringOption(values: Record<string, unknown>, name: string, required = false): string | undefined {
  const value = values[name];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value || value.startsWith('--') || value.includes('\0')) throw new Error(`--${name} requires a value`);
  return value;
}

function numberOption(values: Record<string, unknown>, name: string): number | undefined {
  const value = stringOption(values, name);
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`--${name} requires a positive integer`);
  return Number(value);
}

/** Read either schema version without ever rewriting it. */
function readReport(raw: unknown): AnyReport {
  const version = raw && typeof raw === 'object' ? (raw as { schemaVersion?: unknown }).schemaVersion : undefined;
  return version === 2 ? validateSweepReport(raw) : validateReport(raw);
}

interface CliOutput { out(value: string): void; err(value: string): void; }
function printReport(report: AnyReport, json: boolean, output: CliOutput): number {
  const rendered = report.schemaVersion === 2 ? renderSweepMarkdown(report) : renderMarkdown(report);
  output.out(json ? `${JSON.stringify(report, null, 2)}\n` : rendered);
  for (const item of report.missing) output.err(`Incomplete: ${item}\n`);
  return exitCode(report);
}

function setupMessage(error: unknown): string {
  if (error instanceof SyntaxError) return 'JSON input could not be parsed; input contents were not included';
  if (error instanceof Error && error.name === 'ZodError') return 'Input does not match the supported scenario/report contract';
  return (error instanceof Error ? error.message : 'Retryglass command failed').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 500);
}

/** Execute a CLI request and return its exit status; setup/tool failures always return 2. */
export async function runCli(args: string[], output: CliOutput = { out: value => { process.stdout.write(value); }, err: value => { process.stderr.write(value); } }): Promise<number> {
  let json = args.includes('--json');
  try {
    if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0]!)) { output.out(`${USAGE}\n${Object.values(HELP).join('\n')}\n`); return 0; }
    if (args.length === 1 && ['--version', '-v'].includes(args[0]!)) {
      const manifest = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version?: unknown };
      if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+[a-zA-Z0-9.+-]*$/.test(manifest.version)) throw new Error('Package version is unavailable');
      output.out(`${manifest.version}\n`); return 0;
    }
    const command = args[0] ?? '';
    const definitions = commandOptions(command);
    const parsed = parseArgs({ args: args.slice(1), options: definitions, strict: true, allowPositionals: false, tokens: true });
    const seen = new Set<string>();
    for (const token of parsed.tokens) {
      if (token.kind !== 'option') continue;
      if (seen.has(token.name) && !definitions[token.name]?.multiple) throw new Error(`--${token.name} may only be supplied once`);
      seen.add(token.name);
    }
    const values = parsed.values;
    json = values.json === true;
    if (values.help) { output.out(`${HELP[command]}\n`); return 0; }
    if (command === 'init') {
      const initialized = await initializeStarter(stringOption(values, 'target', true)!);
      output.out(json ? `${JSON.stringify(initialized, null, 2)}\n` : `Created synthetic starter at ${initialized.target}\nNext: retryglass validate --scenario ${join(initialized.target, 'scenario.json')}\n`);
      return 0;
    }
    if (command === 'validate') {
      const result = await validateScenarioFile(stringOption(values, 'scenario', true)!);
      output.out(json ? `${JSON.stringify(result, null, 2)}\n` : `Configuration: ${result.valid ? 'valid' : 'invalid'}\nScope: configuration and contained fixture files only\n${result.diagnostics.map(item => `${item.severity}: ${item.message}\n`).join('')}`);
      return result.valid ? 0 : 2;
    }
    if (command === 'doctor') {
      const result = await inspectPrerequisites({ scenarioPath: stringOption(values, 'scenario') });
      output.out(json ? `${JSON.stringify(result, null, 2)}\n` : `Engine: ${result.engine.status}${result.engine.version ? ` (${result.engine.version})` : ''}\n${result.engine.reason ? `${result.engine.reason}\n` : ''}${result.images.map(image => `Local image ${image.image}: ${image.status}\n`).join('')}${result.scenario && !result.scenario.valid ? 'Scenario: invalid; run validate for details\n' : ''}Read-only prerequisite check; no image was pulled or built.\n`);
      return result.ready ? 0 : 2;
    }
    if (command === 'run') {
      const report = await runScenario(stringOption(values, 'scenario', true)!, { outputRoot: stringOption(values, 'output-root') ?? '.retryglass', signal: AbortSignal.timeout(10 * 60_000) });
      return printReport(report, json, output);
    }
    if (command === 'sweep') {
      const scenarioPath = stringOption(values, 'scenario', true)!;
      const crashPoints = values['crash-point'] as string[] | undefined;
      if (crashPoints?.some(id => !/^cp-\d{2,3}$/.test(id))) throw new Error('--crash-point requires a cp-NN identity');
      const report = await runSweep(scenarioPath, {
        outputRoot: stringOption(values, 'output-root') ?? '.retryglass',
        maxCrashPoints: numberOption(values, 'max-crash-points'),
        discoveryRuns: numberOption(values, 'discovery-runs'),
        crashPoints,
        signal: AbortSignal.timeout(30 * 60_000),
      });
      return printReport(report, json, output);
    }
    if (command === 'inspect') {
      const report = readReport(JSON.parse(await readFile(stringOption(values, 'report', true)!, 'utf8')) as unknown);
      return printReport(report, json, output);
    }
    if (command === 'export') {
      const runId = stringOption(values, 'run', true)!, target = stringOption(values, 'target', true)!;
      const outputRoot = stringOption(values, 'output-root') ?? '.retryglass';
      const crashPoint = stringOption(values, 'crash-point');
      const exported = crashPoint ? await exportCrashPoint(runId, crashPoint, target, { outputRoot }) : await exportFixture(runId, target, { outputRoot });
      output.out(json ? `${JSON.stringify({ target: exported })}\n` : `Exported ${exported}\n`);
      return 0;
    }
    if (command === 'demo') return printReport(await runDemo(), json, output);
    throw new Error(USAGE);
  } catch (error) {
    const message = setupMessage(error);
    if (json) output.out(`${JSON.stringify({ error: message })}\n`);
    else output.err(`${message}\n`);
    return 2;
  }
}

/**
 * True only when this module is the process entrypoint.
 *
 * `process.argv[1]` keeps the path the process was started with — for a package installed by npm or
 * pnpm that is the `node_modules/.bin/retryglass` symlink — while `import.meta.url` is resolved to
 * the real file. Comparing them literally therefore never matched, and the installed CLI exited 0
 * without running anything. Both sides are compared after `realpath`, which is what the previous
 * comparison intended.
 */
export function isEntryPoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false; // an unreadable path cannot be this module's entrypoint
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  runCli(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Retryglass command failed'}\n`);
    process.exitCode = 2;
  });
}
