// npm run seed            → seeds only if the database is empty
// npm run seed -- --reset → wipes the database, then seeds fresh demo data
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../db/connect.js';
import { seed, seedIfEmpty } from './seed.js';

const reset = process.argv.includes('--reset');
await connectDb();
if (reset) {
  await mongoose.connection.dropDatabase();
  await connectDb(); // rebuild indexes on the empty database
  await seed();
  console.log('Database reset and seeded.');
} else {
  console.log((await seedIfEmpty()) ? 'Seeded demo data.' : 'Database already has data; use --reset to start over.');
}
await disconnectDb();
