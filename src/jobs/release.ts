import os from 'node:os';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { JobLock } from '../models/misc.js';
import { releaseDue } from '../services/commissions.js';

const holder = `${os.hostname()}:${process.pid}`;

/**
 * Takes a short lease so that, with several API instances, only one runs the job at a time.
 * The update only matches an expired (or missing) lease; losing the race shows up as a duplicate key.
 */
async function acquire(name: string, ttlMs: number) {
  const now = new Date();
  try {
    await JobLock.findOneAndUpdate(
      { _id: name, $or: [{ lockedUntil: { $lt: now } }, { lockedUntil: null }] },
      { $set: { lockedUntil: new Date(now.getTime() + ttlMs), holder } },
      { upsert: true },
    );
    return true;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return false;
    throw err;
  }
}

async function runOnce() {
  if (!(await acquire('release-due', 5 * 60_000))) return;
  const result = await releaseDue();
  if (result.released) logger.info('Released due commissions', result);
}

/** Moves commissions out of the return window on a timer. Returns a stop function. */
export function startReleaseJob() {
  const every = env.RELEASE_JOB_INTERVAL_MIN * 60_000;
  const tick = () => runOnce().catch((err) => logger.error('Release job failed', { error: String(err) }));
  void tick();
  const timer = setInterval(tick, every);
  timer.unref();
  return () => clearInterval(timer);
}
