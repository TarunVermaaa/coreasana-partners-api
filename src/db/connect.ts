import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

mongoose.set('strictQuery', true);

export async function connectDb(uri = env.MONGODB_URI) {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  // Build declared indexes (unique codes, one sale commission per order, …) before taking traffic.
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  logger.info('Connected to MongoDB', { db: mongoose.connection.name });
}

export async function disconnectDb() {
  await mongoose.disconnect();
}

export const dbState = () => (mongoose.connection.readyState === 1 ? 'up' : 'down');

/**
 * Runs `fn` in a transaction with automatic retry on transient errors (write conflicts).
 * Used wherever several documents must change together, e.g. creating a payout batch
 * and locking the commissions it pays.
 */
export async function withTransaction<T>(fn: (session: mongoose.ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
