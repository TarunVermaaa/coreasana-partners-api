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

/**
 * Typical order value over the last 90 days, for the earnings calculator in the app.
 * The median, not the mean: one bulk studio order shouldn't promise every new teacher lakhs a month.
 */
async function averageOrderValue(now: Date): Promise<number> {
  const rows = await Order.find({ placedAt: { $gte: addDays(now, -90), $lte: now }, status: { $ne: 'refunded' } }, { total: 1, _id: 0 })
    .sort({ placedAt: -1 })
    .limit(1000)
    .lean();
  if (rows.length < 5) return FALLBACK_AOV;
  const totals = rows.map((r) => r.total).sort((a, b) => a - b);
  const mid = Math.floor(totals.length / 2);
  const median = totals.length % 2 ? totals[mid] : (totals[mid - 1] + totals[mid]) / 2;
  return Math.round(median / 100) * 100;
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
