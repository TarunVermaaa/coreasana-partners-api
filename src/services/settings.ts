import type { ClientSession } from 'mongoose';
import { nextPayoutDate } from '../lib/dates.js';
import { addDays } from '../lib/dates.js';
import { Order } from '../models/order.js';
import { Settings, type SettingsFields } from '../models/misc.js';

export type ProgramSettings = Pick<
  SettingsFields,
  'commissionRateBps' | 'customerDiscountPct' | 'holdDays' | 'minPayout' | 'payoutWeekday' | 'tdsRateBps' | 'tdsNoPanRateBps' | 'highValueOrder'
>;

/** Reads the program settings, creating the defaults on first use (upsert is race-safe). */
export async function getSettings(session?: ClientSession): Promise<ProgramSettings> {
  const doc = await Settings.findOneAndUpdate(
    { key: 'program' },
    { $setOnInsert: { key: 'program' } },
    { upsert: true, new: true, setDefaultsOnInsert: true, session },
  ).lean();
  return doc!;
}

const FALLBACK_AOV = 200_000; // ₹2,000 — roughly the middle of Core Asana's bestsellers

/** Average order value over the last 90 days; powers the earnings calculator in the app. */
async function averageOrderValue(now: Date): Promise<number> {
  const [row] = await Order.aggregate<{ avg: number }>([
    { $match: { placedAt: { $gte: addDays(now, -90) }, status: { $ne: 'refunded' } } },
    { $group: { _id: null, avg: { $avg: '$total' } } },
  ]);
  return row ? Math.round(row.avg / 100) * 100 : FALLBACK_AOV;
}

/** The public program terms shown before signup. */
export async function programTerms(now = new Date()) {
  const s = await getSettings();
  return {
    commissionRatePct: s.commissionRateBps / 100,
    customerDiscountPct: s.customerDiscountPct,
    holdDays: s.holdDays,
    minPayout: s.minPayout,
    payoutWeekday: s.payoutWeekday,
    nextPayoutDate: nextPayoutDate(now, s.payoutWeekday),
    averageOrderValue: await averageOrderValue(now),
    tdsRatePct: s.tdsRateBps / 100,
    tdsNoPanRatePct: s.tdsNoPanRateBps / 100,
  };
}
