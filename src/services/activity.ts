import type { ClientSession } from 'mongoose';
import { Activity } from '../models/misc.js';
import type { Actor } from '../models/commission.js';

export const SYSTEM: Actor = { type: 'system', name: 'Release job' };

export interface ActivityInput {
  at?: Date;
  actor: Actor;
  action: string;
  entity: 'affiliate' | 'order' | 'commission' | 'payout' | 'settings';
  entityId?: string;
  summary: string;
  meta?: Record<string, unknown>;
}

/** Writes one audit entry. Pass the session when the change it describes is part of a transaction. */
export async function record(entry: ActivityInput, session?: ClientSession) {
  await Activity.create([{ ...entry, at: entry.at ?? new Date() }], { session });
}

export async function listActivity(filter: { entityId?: string; entity?: string; limit: number; before?: string }) {
  const query: Record<string, unknown> = {};
  if (filter.entityId) query.entityId = filter.entityId;
  if (filter.entity) query.entity = filter.entity;
  if (filter.before) query.at = { $lt: new Date(filter.before) };
  const rows = await Activity.find(query).sort({ at: -1, _id: -1 }).limit(filter.limit).lean();
  return {
    items: rows.map((r) => ({
      id: String(r._id),
      at: r.at,
      actor: { type: r.actor.type, name: r.actor.name },
      action: r.action,
      entity: r.entity,
      entityId: r.entityId ?? null,
      summary: r.summary,
    })),
  };
}
