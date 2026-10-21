import { Types } from 'mongoose';
import { addDays, istDay, istStartOfDay } from '../lib/dates.js';
import { ApiError } from '../lib/errors.js';
import { Affiliate } from '../models/affiliate.js';
import { Commission, type Actor } from '../models/commission.js';
import { ClickDay } from '../models/misc.js';
import { Order } from '../models/order.js';
import { record } from './activity.js';
import { affiliateDto, hydrateCommissions } from './dto.js';
import { buildPreview } from './payouts.js';

const sumCount = { amount: { $sum: '$amount' }, count: { $sum: 1 } };

/** Where all commission money is right now — the dashboard's pipeline strip. */
export async function pipeline(now = new Date()) {
  const [row] = await Commission.aggregate([
    {
      $facet: {
        needsReview: [{ $match: { status: 'pending', 'flags.0': { $exists: true }, review: null } }, { $group: { _id: null, ...sumCount } }],
        onHold: [{ $match: { status: 'pending', $or: [{ 'flags.0': { $exists: false } }, { review: { $ne: null } }] } }, { $group: { _id: null, ...sumCount } }],
        ready: [{ $match: { status: 'approved' } }, { $group: { _id: null, ...sumCount } }],
        inPayout: [{ $match: { status: 'in_payout' } }, { $group: { _id: null, ...sumCount } }],
        paid30d: [{ $match: { status: 'paid', paidAt: { $gte: addDays(now, -30) } } }, { $group: { _id: null, ...sumCount } }],
      },
    },
  ]);
  const pick = (k: string) => ({ amount: row[k][0]?.amount ?? 0, count: row[k][0]?.count ?? 0 });
  return { onHold: pick('onHold'), needsReview: pick('needsReview'), ready: pick('ready'), inPayout: pick('inPayout'), paid30d: pick('paid30d') };
}

export async function overview(now = new Date()) {
  const since30 = istStartOfDay(addDays(now, -29));
  const [pipe, activeAffiliates, new7, new30, ordersAgg, commissionDaily, signupDaily, clicks, top, preview] = await Promise.all([
    pipeline(now),
    Affiliate.countDocuments({ status: 'active' }),
    Affiliate.countDocuments({ createdAt: { $gte: addDays(now, -7) } }),
    Affiliate.countDocuments({ createdAt: { $gte: addDays(now, -30) } }),
    Order.aggregate<{ _id: string; orders: number; sales: number }>([
      { $match: { placedAt: { $gte: since30 } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$placedAt', timezone: 'Asia/Kolkata' } }, orders: { $sum: 1 }, sales: { $sum: '$total' } } },
    ]),
    Commission.aggregate<{ _id: string; amount: number }>([
      { $match: { kind: 'sale', placedAt: { $gte: since30 }, status: { $nin: ['reversed', 'rejected'] } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$placedAt', timezone: 'Asia/Kolkata' } }, amount: { $sum: '$amount' } } },
    ]),
    Affiliate.aggregate<{ _id: string; n: number }>([
      { $match: { createdAt: { $gte: since30 } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Kolkata' } }, n: { $sum: 1 } } },
    ]),
    ClickDay.aggregate<{ total: number }>([{ $match: { day: { $gte: istDay(since30) } } }, { $group: { _id: null, total: { $sum: '$count' } } }]),
    Order.aggregate<{ _id: Types.ObjectId; sales: number; orders: number }>([
      { $match: { placedAt: { $gte: addDays(now, -30) }, status: { $ne: 'refunded' } } },
      { $group: { _id: '$affiliateId', sales: { $sum: '$total' }, orders: { $sum: 1 } } },
      { $sort: { sales: -1 } },
      { $limit: 5 },
    ]),
    buildPreview(now),
  ]);

  const byDay = <T extends { _id: string }>(rows: T[]) => new Map(rows.map((r) => [r._id, r]));
  const o = byDay(ordersAgg);
  const c = byDay(commissionDaily);
  const s = byDay(signupDaily);
  const daily = Array.from({ length: 30 }, (_, i) => {
    const date = istDay(addDays(since30, i));
    return {
      date,
      orders: o.get(date)?.orders ?? 0,
      sales: o.get(date)?.sales ?? 0,
      commission: c.get(date)?.amount ?? 0,
      signups: s.get(date)?.n ?? 0,
    };
  });

  const topAffiliates = await Affiliate.find({ _id: { $in: top.map((t) => t._id) } }, { name: 1, code: 1 }).lean();
  const names = new Map(topAffiliates.map((a) => [String(a._id), a]));

  return {
    pipeline: pipe,
    program: {
      activeAffiliates,
      newAffiliates7d: new7,
      newAffiliates30d: new30,
      sales30d: daily.reduce((sum, d) => sum + d.sales, 0),
      orders30d: daily.reduce((sum, d) => sum + d.orders, 0),
      clicks30d: clicks[0]?.total ?? 0,
    },
    daily,
    topAffiliates: top.map((t) => ({
      id: String(t._id),
      name: names.get(String(t._id))?.name ?? 'Unknown',
      code: names.get(String(t._id))?.code ?? '',
      sales30d: t.sales,
      orders30d: t.orders,
    })),
    nextPayout: {
      date: preview.scheduledFor,
      eligibleCount: preview.eligible.length,
      eligibleNet: preview.eligible.reduce((sum, e) => sum + e.net, 0),
      blockedCount: preview.blocked.length,
    },
  };
}

/** Per-partner numbers for the partners table, computed for one page of partners at a time. */
async function statsFor(ids: Types.ObjectId[]) {
  const [orders, earnings] = await Promise.all([
    Order.aggregate<{ _id: Types.ObjectId; orders: number; sales: number }>([
      { $match: { affiliateId: { $in: ids }, status: { $ne: 'refunded' } } },
      { $group: { _id: '$affiliateId', orders: { $sum: 1 }, sales: { $sum: '$total' } } },
    ]),
    Commission.aggregate<{ _id: Types.ObjectId; earned: number; ready: number }>([
      { $match: { affiliateId: { $in: ids }, status: { $in: ['pending', 'approved', 'in_payout', 'paid'] } } },
      {
        $group: {
          _id: '$affiliateId',
          earned: { $sum: { $cond: [{ $in: ['$status', ['approved', 'in_payout', 'paid']] }, '$amount', 0] } },
          ready: { $sum: { $cond: [{ $eq: ['$status', 'approved'] }, '$amount', 0] } },
        },
      },
    ]),
  ]);
  const o = new Map(orders.map((r) => [String(r._id), r]));
  const e = new Map(earnings.map((r) => [String(r._id), r]));
  return (id: Types.ObjectId) => ({
    orders: o.get(String(id))?.orders ?? 0,
    sales: o.get(String(id))?.sales ?? 0,
    earned: e.get(String(id))?.earned ?? 0,
    ready: e.get(String(id))?.ready ?? 0,
  });
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function listAffiliates(params: { search?: string; status?: 'active' | 'suspended'; limit: number; cursor?: string }) {
  const query: Record<string, unknown> = {};
  if (params.status) query.status = params.status;
  if (params.search) {
    const re = new RegExp(escapeRegex(params.search.trim()), 'i');
    query.$or = [{ name: re }, { email: re }, { code: re }, { city: re }];
  }
  if (params.cursor) query._id = { $lt: new Types.ObjectId(params.cursor) };
  const rows = await Affiliate.find(query).sort({ _id: -1 }).limit(params.limit + 1).lean();
  const page = rows.slice(0, params.limit);
  const stats = await statsFor(page.map((a) => a._id));
  return {
    items: page.map((a) => ({ ...affiliateDto(a), stats: stats(a._id) })),
    nextCursor: rows.length > params.limit ? String(page[page.length - 1]._id) : null,
  };
}

export async function affiliateDetail(id: string) {
  const a = await Affiliate.findById(id).lean();
  if (!a) throw ApiError.notFound('Partner');
  const [stats, recent] = await Promise.all([statsFor([a._id]), Commission.find({ affiliateId: a._id }).sort({ _id: -1 }).limit(10).lean()]);
  return { ...affiliateDto(a), stats: stats(a._id), recentCommissions: await hydrateCommissions(recent) };
}

export async function setAffiliateStatus(id: string, status: 'active' | 'suspended', actor: Actor) {
  const a = await Affiliate.findByIdAndUpdate(id, { $set: { status } }, { new: true }).lean();
  if (!a) throw ApiError.notFound('Partner');
  await record({
    actor,
    action: status === 'suspended' ? 'affiliate.suspended' : 'affiliate.activated',
    entity: 'affiliate',
    entityId: id,
    summary: `${status === 'suspended' ? 'Paused' : 'Reactivated'} ${a.name} (${a.code})`,
  });
  return affiliateDto(a);
}

/** Commission views for the review screen. */
export function commissionView(view: string, now: Date): Record<string, unknown> {
  switch (view) {
    case 'needs_review':
      return { status: 'pending', 'flags.0': { $exists: true }, review: null };
    case 'on_hold':
      return { status: 'pending', $or: [{ 'flags.0': { $exists: false } }, { review: { $ne: null } }] };
    case 'due':
      return { status: 'pending', kind: 'sale', holdUntil: { $lte: now }, 'flags.0': { $exists: false } };
    case 'ready':
      return { status: 'approved' };
    case 'in_payout':
      return { status: 'in_payout' };
    case 'paid':
      return { status: 'paid' };
    case 'reversed':
      return { status: { $in: ['reversed', 'rejected'] } };
    default:
      return {};
  }
}

export async function commissionTotals(filter: Record<string, unknown>) {
  const [row] = await Commission.aggregate<{ amount: number; count: number }>([{ $match: filter }, { $group: { _id: null, ...sumCount } }]);
  return { amount: row?.amount ?? 0, count: row?.count ?? 0 };
}

