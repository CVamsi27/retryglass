import { SEAMS, type CrashPoint, type Seam } from '../contracts.js';

/** Plan cap: a sweep never enumerates more than this many crash points. */
export const MAX_CRASH_POINTS = 64;
/** A descriptor line is bounded by construction; anything longer is not ours. */
const MAX_LINE = 512;
const MAX_LABEL = 200;
export const MAX_IO_OBSERVATIONS = 16;

export interface ParsedMarker { crashAfter: number; completed: number; }
export interface IoObservation { kind: string; target: string; declared: boolean; }

export interface SeamDescriptor { index: number; seam: Seam; label: string; }

export interface SeamLog {
  descriptors: SeamDescriptor[];
  marker: ParsedMarker | null;
  io: IoObservation[];
  unknownSeams: string[];
  malformed: number;
}

const SEAM_SET = new Set<string>(SEAMS);

function boundedLabel(value: string): string {
  return value.length > MAX_LABEL ? `${value.slice(0, MAX_LABEL - 1)}\u2026` : value;
}

/**
 * Parse the bounded JSONL a worker writes to stdout: seam descriptors, at most one crash marker,
 * and undeclared-I/O observations. Worker noise is ignored; a line that is not JSON, or is larger
 * than a descriptor can be, is counted as malformed. Nothing is repaired or guessed.
 */
export function parseSeamLog(logs: string): SeamLog {
  const result: SeamLog = { descriptors: [], marker: null, io: [], unknownSeams: [], malformed: 0 };
  const seenIo = new Set<string>();

  for (const rawLine of logs.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.length > MAX_LINE) { result.malformed++; continue; }

    let parsed: unknown;
    try { parsed = JSON.parse(line); }
    catch { result.malformed++; continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;

    const record = parsed as Record<string, unknown>;
    const kind = record.kind;

    if (kind === 'crash-marker') {
      const { crashAfter, completed } = record;
      if (typeof crashAfter !== 'number' || !Number.isFinite(crashAfter)) continue;
      if (typeof completed !== 'number' || !Number.isFinite(completed)) continue;
      result.marker = { crashAfter, completed };
      continue;
    }

    if (kind === 'io-observation') {
      // The worker writes { kind: 'io-observation', io: <observed kind>, target, declared }.
      const effectiveKind = typeof record.io === 'string' ? record.io : undefined;
      const target = typeof record.target === 'string' ? record.target : 'unknown';
      if (typeof effectiveKind !== 'string') continue;
      if (record.declared === true) continue; // declared destinations are not findings
      const key = `${effectiveKind}:${target}`;
      if (seenIo.has(key) || result.io.length >= MAX_IO_OBSERVATIONS) continue;
      seenIo.add(key);
      result.io.push({ kind: effectiveKind.slice(0, 48), target: target.slice(0, 120), declared: false });
      continue;
    }

    const index = record.index;
    const seam = record.seam;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) continue;
    if (typeof seam !== 'string') continue;
    if (!SEAM_SET.has(seam)) {
      if (!result.unknownSeams.includes(seam)) result.unknownSeams.push(seam.slice(0, 64));
      continue;
    }
    const label = typeof record.label === 'string' ? boundedLabel(record.label) : seam;
    result.descriptors.push({ index, seam: seam as Seam, label });
  }

  return result;
}

export interface DiscoveryResult {
  points: CrashPoint[];
  /** Descriptors the discovery run actually reported, before the cap is applied. */
  observed: number;
  stable: boolean;
  moreObserved: boolean;
  unsupported: IoObservation[];
  unknownSeams: string[];
  reasons: string[];
}

function sequence(log: SeamLog): string {
  return log.descriptors.map(descriptor => `${descriptor.index}:${descriptor.seam}:${descriptor.label}`).join('|');
}

/**
 * Enumerate crash points from one or more discovery runs.
 *
 * Crash points are identified by settled-seam index, not by seam label: the labels come from a
 * fixed table, so `seam:label` deduplication would collapse genuinely different boundaries. One
 * descriptor per index, contiguous from 0, is required — a gap means a descriptor was lost and the
 * order cannot be trusted.
 */
export function discoverCrashPoints(
  logs: readonly string[],
  options?: { maxCrashPoints?: number },
): DiscoveryResult {
  const cap = options?.maxCrashPoints ?? MAX_CRASH_POINTS;
  const reasons: string[] = [];
  if (!logs.length) {
    return { points: [], observed: 0, stable: false, moreObserved: false, unsupported: [], unknownSeams: [], reasons: ['no discovery run was performed'] };
  }

  const parsed = logs.map(parseSeamLog);
  const unsupported: IoObservation[] = [];
  const unknownSeams: string[] = [];
  for (const log of parsed) {
    for (const event of log.io) {
      if (!unsupported.some(entry => entry.kind === event.kind && entry.target === event.target)) unsupported.push(event);
    }
    for (const seam of log.unknownSeams) if (!unknownSeams.includes(seam)) unknownSeams.push(seam);
  }

  const primary = parsed[0]!;
  let stable = true;

  // Contiguity, uniqueness and order are checked on every run, not just the first.
  for (const [run, log] of parsed.entries()) {
    const label = `discovery run ${run + 1}`;
    if (!log.descriptors.length) {
      stable = false;
      reasons.push(`${label} observed no declared seam`);
      continue;
    }
    log.descriptors.forEach((descriptor, position) => {
      if (descriptor.index !== position) {
        stable = false;
        reasons.push(`${label} reported seam index ${descriptor.index} at position ${position} (a descriptor is missing or repeated)`);
      }
    });
    if (log.malformed) {
      stable = false;
      reasons.push(`${label} contained ${log.malformed} malformed descriptor line(s)`);
    }
    if (run > 0 && sequence(log) !== sequence(primary)) {
      stable = false;
      reasons.push(`${label} enumerated a different seam order than discovery run 1`);
    }
  }

  const moreObserved = primary.descriptors.length > cap;
  if (moreObserved) reasons.push(`sweep cap reached: ${primary.descriptors.length} crash points observed, ${cap} enumerated`);

  const usable = stable ? primary.descriptors.slice(0, cap) : [];
  const points: CrashPoint[] = usable.map((descriptor) => ({
    // cp-01 is "crash after the first settled seam", i.e. CRASH_AFTER=1.
    id: `cp-${String(descriptor.index + 1).padStart(2, '0')}`,
    index: descriptor.index,
    seam: descriptor.seam,
    label: descriptor.label,
  }));

  return {
    points, observed: primary.descriptors.length, stable, moreObserved, unsupported, unknownSeams,
    reasons: [...new Set(reasons)],
  };
}

/** The 1-based CRASH_AFTER value for a crash point. */
export function crashAfterFor(point: CrashPoint): number {
  return point.index + 1;
}
