import { MongoMemoryReplSet } from 'mongodb-memory-server';

// Transactions need a replica set, so tests run against an in-memory single-node one.
export default async function setup() {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.MONGODB_URI = replSet.getUri('partners_test');
  return async () => {
    await replSet.stop();
  };
}
