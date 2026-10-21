import type { Types } from 'mongoose';
import { Affiliate, type AffiliateFields } from '../models/affiliate.js';
import type { CommissionFields } from '../models/commission.js';
import { Order } from '../models/order.js';
import { Payout } from '../models/payout.js';
import { methodDto } from './payouts.js';

type WithId<T> = T & { _id: Types.ObjectId; createdAt?: Date; updatedAt?: Date };

/** Partner profile as the API returns it. Encrypted fields never leave the server. */
export function affiliateDto(a: WithId<AffiliateFields>) {
  return {
    id: String(a._id),
    name: a.name,
    email: a.email,
    phone: a.phone,
    code: a.code,
    audience: a.audience,
    city: a.city ?? null,
    instagram: a.instagram ?? null,
    status: a.status,
    payoutMethod: a.payoutMethod ? methodDto(a.payoutMethod) : null,
    panLast4: a.panLast4 ?? null,
    createdAt: a.createdAt,
  };
}

/**
 * Commissions with the order and payout details the screens need, loaded in two batched queries
 * (not one per row).
 */
export async function hydrateCommissions(rows: WithId<CommissionFields>[], opts: { includeAffiliate?: boolean } = {}) {
  const orderIds = [...new Set(rows.map((r) => String(r.orderId)))];
  const payoutIds = [...new Set(rows.filter((r) => r.payoutId).map((r) => String(r.payoutId)))];
  const affiliateIds = opts.includeAffiliate ? [...new Set(rows.map((r) => String(r.affiliateId)))] : [];

  const [orders, payouts, affiliates] = await Promise.all([
    Order.find({ _id: { $in: orderIds } }, { externalId: 1, placedAt: 1, items: 1, total: 1, status: 1 }).lean(),
    payoutIds.length ? Payout.find({ _id: { $in: payoutIds } }, { number: 1, status: 1, items: 1 }).lean() : [],
    affiliateIds.length ? Affiliate.find({ _id: { $in: affiliateIds } }, { name: 1, code: 1 }).lean() : [],
  ]);
  const orderById = new Map(orders.map((o) => [String(o._id), o]));
  const payoutById = new Map(payouts.map((p) => [String(p._id), p]));
  const affiliateById = new Map(affiliates.map((a) => [String(a._id), a]));

  return rows.map((c) => {
    const o = orderById.get(String(c.orderId));
    const p = c.payoutId ? payoutById.get(String(c.payoutId)) : undefined;
    const item = p?.items.find((i) => String(i.affiliateId) === String(c.affiliateId));
    const a = affiliateById.get(String(c.affiliateId));
    return {
      id: String(c._id),
      kind: c.kind,
      order: o
        ? {
            id: String(o._id),
            externalId: o.externalId,
            placedAt: o.placedAt,
            items: o.items.map((i) => ({ name: i.name, qty: i.qty })),
            total: o.total,
            status: o.status,
          }
        : null,
      base: c.base,
      ratePct: c.rateBps / 100,
      amount: c.amount,
      status: c.status,
      holdUntil: c.holdUntil,
      flags: c.flags.map((f) => ({ code: f.code, message: f.message })),
      needsReview: c.status === 'pending' && c.flags.length > 0 && !c.review,
      review: c.review ? { decision: c.review.decision, note: c.review.note ?? null, by: c.review.by?.name ?? null, at: c.review.at } : null,
      payout: p ? { id: String(p._id), number: p.number, status: item?.status ?? p.status, utr: item?.utr ?? null, paidAt: item?.paidAt ?? null } : null,
      history: c.history.map((h) => ({ at: h.at, from: h.from ?? null, to: h.to, by: { type: h.by.type, name: h.by.name }, note: h.note ?? null })),
      createdAt: c.createdAt,
      ...(a ? { affiliate: { id: String(a._id), name: a.name, code: a.code } } : {}),
    };
  });
}
