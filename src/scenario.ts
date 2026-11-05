import { open, realpath } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { MAX_FIXTURE_BYTES, MAX_SCENARIO_BYTES, validateScenario, type Scenario } from './contracts.js';

async function readBounded(path: string, maximum: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Fixture must be a regular file');
    if (stat.size > maximum) throw new Error(`File exceeds the ${maximum} byte size limit`);
    const buffer = Buffer.alloc(maximum + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maximum) throw new Error(`File exceeds the ${maximum} byte size limit`);
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

async function containedFixture(root: string, path: string): Promise<Buffer> {
  const actual = await realpath(resolve(root, path));
  const within = relative(root, actual);
  if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error('Fixture symlink escapes the selected directory');
  return readBounded(actual, MAX_FIXTURE_BYTES);
}

export interface LoadedScenario {
  scenario: Scenario;
  fixtureRoot: string;
  fixtureDigests: { schema: string; seed: string };
  /** Exact validated inputs, so a run can preserve what it actually rehearsed. */
  contents: { scenario: string; schema: string; seed: string };
}

export async function loadScenario(path: string): Promise<LoadedScenario> {
  if (extname(path).toLowerCase() !== '.json') throw new Error('Scenario configuration must be a JSON file');
  const actual = await realpath(path);
  const fixtureRoot = dirname(actual);
  const bytes = await readBounded(actual, MAX_SCENARIO_BYTES);
  const scenario = validateScenario(JSON.parse(bytes.toString('utf8')) as unknown);
  const [schema, seed] = await Promise.all([
    containedFixture(fixtureRoot, scenario.fixture.schema), containedFixture(fixtureRoot, scenario.fixture.seed),
  ]);
  const digest = (content: Buffer) => createHash('sha256').update(content).digest('hex');
  return {
    scenario,
    fixtureRoot,
    fixtureDigests: { schema: digest(schema), seed: digest(seed) },
    contents: { scenario: bytes.toString('utf8'), schema: schema.toString('utf8'), seed: seed.toString('utf8') },
  };
}
