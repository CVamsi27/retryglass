import { spawn } from 'node:child_process';
import { z } from 'zod';
import { loadScenario } from './scenario.js';
import { POSTGRES_IMAGE, REDIS_IMAGE, TOOL_IMAGE } from './docker/images.js';

export interface PreflightDiagnostic {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  ruleId?: string;
}
export interface ScenarioValidation {
  schemaVersion: 1;
  valid: boolean;
  scope: 'configuration_and_fixture_files_only';
  scenarioId?: string;
  diagnostics: PreflightDiagnostic[];
}
const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 300);

/** Validate declared JSON, contained fixture files and projection references; never import a processor. */
export async function validateScenarioFile(path: string): Promise<ScenarioValidation> {
  const result: ScenarioValidation = { schemaVersion: 1, valid: false, scope: 'configuration_and_fixture_files_only', diagnostics: [] };
  const diagnostic = (code: string, message: string, ruleId?: string, severity: 'error' | 'warning' = 'error') => {
    if (result.diagnostics.length < 64) result.diagnostics.push({ code, severity, message: clean(message), ...(ruleId ? { ruleId: clean(ruleId) } : {}) });
  };
  try {
    const { scenario } = await loadScenario(path);
    result.scenarioId = clean(scenario.scenarioId);
    const tables = new Map(scenario.tables.map(table => [table.table, table]));
    if (tables.size !== scenario.tables.length) diagnostic('duplicate_table', 'A table projection must be declared exactly once');
    for (const table of scenario.tables) {
      if (new Set(table.columns).size !== table.columns.length || new Set(table.key).size !== table.key.length) diagnostic('duplicate_projection_column', `Projection ${table.table} repeats a key or column`);
      if (!table.key.length || table.key.some(key => !table.columns.includes(key))) diagnostic('unprojected_table_key', `Projection ${table.table} must include every declared key column`);
    }
    for (const name of Object.keys(scenario.fixture.expectedRows)) {
      if (!tables.has(name)) diagnostic('undeclared_fixture_table', `Expected row count refers to undeclared table ${name}`);
    }
    for (const rule of scenario.rules) {
      if (rule.kind !== 'row_value') continue;
      const table = tables.get(rule.table);
      if (!table) continue; // The base scenario validator already rejects this reference.
      if (!table.columns.includes(rule.column)) diagnostic('unprojected_rule_column', `Rule ${rule.id} reads a column outside its declared projection`, rule.id);
      const keys = Object.keys(rule.key);
      if (keys.length !== table.key.length || keys.some(key => !table.key.includes(key))) diagnostic('invalid_rule_key', `Rule ${rule.id} must bind exactly its table's declared key columns`, rule.id);
    }
    if (scenario.job.data.operationKey !== scenario.job.operationKey) diagnostic('mismatched_operation_key', 'job.data.operationKey must equal the declared job.operationKey');
    const positive = scenario.rules.some(rule => rule.kind === 'applied_count' && rule.equals > 0 || rule.kind === 'required_http' && rule.minimum > 0 || rule.kind === 'output_count' && rule.equals > 0 || rule.kind === 'row_count' && rule.equals > 0 || rule.kind === 'row_value');
    if (!positive) diagnostic('no_positive_effect_assertion', 'No positive business-effect assertion is declared; validation does not establish that useful work will occur', undefined, 'warning');
    result.valid = !result.diagnostics.some(item => item.severity === 'error');
  } catch (error) {
    if (error instanceof SyntaxError) diagnostic('invalid_json', 'Scenario is not valid JSON; its contents were not included in this diagnostic');
    else if (error instanceof z.ZodError) {
      for (const issue of error.issues.slice(0, 12)) diagnostic('invalid_scenario', `${issue.path.join('.') || 'scenario'}: ${issue.message}`);
    } else diagnostic('invalid_scenario', error instanceof Error ? error.message : 'Scenario or declared fixture could not be read or validated');
  }
  return result;
}

export interface DoctorOptions { scenarioPath?: string; executable?: string; timeoutMs?: number; }
export interface DoctorReport {
  schemaVersion: 1;
  ready: boolean;
  scope: 'read_only_prerequisites';
  engine: { status: 'available' | 'unavailable' | 'not_checked'; version?: string; reason?: string };
  images: { image: string; status: 'available' | 'missing'; imageId?: string }[];
  scenario: ScenarioValidation | null;
}

async function probe(executable: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (process.env.RETRYGLASS_CONTAINER_HOST) {
      env.DOCKER_HOST = process.env.RETRYGLASS_CONTAINER_HOST;
      delete env.DOCKER_CONTEXT;
    }
    const child = spawn(executable, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env, detached: process.platform !== 'win32', windowsHide: true });
    let stdout = '';
    let bytes = 0;
    let failed = false;
    const stop = () => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* Already exited. */ } };
    const timer = setTimeout(() => { failed = true; stop(); }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 65_536) { failed = true; stop(); } else stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 65_536) { failed = true; stop(); } });
    child.once('error', () => { clearTimeout(timer); reject(new Error('Container client could not be started')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (failed || code !== 0) reject(new Error('Container prerequisite probe failed or exceeded its bounds'));
      else resolve(stdout.trim());
    });
  });
}

/** Inspect only engine/version and declared local images. This never pulls, builds or starts a container. */
export async function inspectPrerequisites(options: DoctorOptions = {}): Promise<DoctorReport> {
  const report: DoctorReport = { schemaVersion: 1, ready: false, scope: 'read_only_prerequisites', engine: { status: 'not_checked' }, images: [], scenario: null };
  if (options.scenarioPath) {
    report.scenario = await validateScenarioFile(options.scenarioPath);
    if (!report.scenario.valid) return report;
  }
  const executable = options.executable ?? process.env.RETRYGLASS_CONTAINER_CLI ?? 'docker';
  const timeout = options.timeoutMs ?? 5_000;
  if (!executable || executable.includes('\0') || !Number.isInteger(timeout) || timeout < 1 || timeout > 10_000) {
    report.engine = { status: 'unavailable', reason: 'Container executable or probe timeout is invalid' };
    return report;
  }
  try {
    const version: unknown = JSON.parse(await probe(executable, ['info', '--format', '{{json .ServerVersion}}'], timeout));
    if (typeof version !== 'string' || !/^\d{1,3}\.\d{1,3}\.\d{1,3}(?:[-+][a-zA-Z0-9_.-]{1,80})?$/.test(version)) throw new Error('Invalid engine version evidence');
    report.engine = { status: 'available', version };
  } catch {
    report.engine = { status: 'unavailable', reason: 'OrbStack/container engine unavailable, timed out, or returned invalid server-version evidence' };
    return report;
  }
  if (options.scenarioPath) {
    const { scenario } = await loadScenario(options.scenarioPath);
    const images = [...new Set([POSTGRES_IMAGE, REDIS_IMAGE, TOOL_IMAGE, scenario.worker.image])];
    for (const image of images) {
      try {
        const id: unknown = JSON.parse(await probe(executable, ['image', 'inspect', '--format', '{{json .Id}}', image], timeout));
        if (typeof id !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error('Invalid image identity');
        report.images.push({ image, status: 'available', imageId: id });
      } catch { report.images.push({ image, status: 'missing' }); }
    }
  }
  report.ready = report.images.every(image => image.status === 'available');
  return report;
}
