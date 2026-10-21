import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { connectDb, disconnectDb } from '../src/db/connect.js';

beforeAll(async () => {
  await connectDb(process.env.MONGODB_URI);
});

beforeEach(async () => {
  // Every test starts from an empty database (indexes stay).
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
});

afterAll(async () => {
  await disconnectDb();
});
