import { z } from 'zod';
import { withTransaction } from '../db/connect.js';
import { fingerprint } from '../lib/crypto.js';
import { addDays } from '../lib/dates.js';
import { applyBps, formatInr } from '../lib/money.js';
import { Affiliate } from '../models/affiliate.js';
import { Commission, type Actor } from '../models/commission.js';
import { Order } from '../models/order.js';
import { record } from './activity.js';
import { moveCommissions } from './commissions.js';
import { getSettings } from './settings.js';

const paise = z.number().int().min(0);

/** The order payload the store sends (money in paise). Same shape for the webhook and the demo tool. */
export const IncomingOrderSchema = z.object({
  id: z.string().trim().min(1).max(64),
  placedAt: z.coerce.date(),
  code: z.string().trim().min(1).max(20),
  customer: z.object({ email: z.string().trim().max(200).optional(), phone: z.string().trim().max(20).optional() }).default({}),
  items: z.array(z.object({ sku: z.string().max(64).optional(), name: z.string().min(1).max(200), qty: z.number().int().min(1), price: paise })).min(1),
  subtotal: paise,
  discount: paise.default(0),
  shipping: paise.default(0),
  tax: paise.default(0),
  total: paise,
})
  .refine((o) => o.discount <= o.subtotal, { path: ['discount'], message: 'Discount cannot be more than the subtotal' })
  // A little clock skew between the store and the API is fine; a date in the future would hold the
  // commission forever.
  .refine((o) => o.placedAt.getTime() <= Date.now() + 10 * 60_000, { path: ['placedAt'], message: 'Order date is in the future' });
export type IncomingOrder = z.infer<typeof IncomingOrderSchema>;

export const IncomingRefundSchema = z.object({
  id: z.string().trim().min(1).max(64),
  refundedAmount: paise, // cumulative amount refunded on the order so far
  refundedAt: z.coerce.date().optional(),
});
export type IncomingRefund = z.infer<typeof IncomingRefundSchema>;

const REPEAT_CUSTOMER_LIMIT = 4; // orders by one shopper with one code in 30 days

type IngestResult =
  | { status: 'created' | 'duplicate'; orderId: string; commissionId: string | null }
  | { status: 'ignored'; reason: 'unknown_code' | 'partner_suspended' };

/**
 * Turns a store order into a commission. Safe to call more than once with the same order:
 * the order id is the idempotency key, and a unique index guarantees one sale commission per order.
 */
export async function ingestOrder(
  input: IncomingOrder,
  opts: { source?: 'webhook' | 'demo'; actor?: Actor; now?: Date } = {},
): Promise<IngestResult> {
  const now = opts.now ?? new Date();
  const actor: Actor = opts.actor ?? { type: 'webhook', name: 'Store webhook' };

  const existing = await Order.findOne({ externalId: input.id }, { _id: 1 }).lean();
  if (existing) return duplicateOf(String(existing._id));

  const code = input.code.toUpperCase();
  const affiliate = await Affiliate.findOne({ code }).lean();
  if (!affiliate) return { status: 'ignored', reason: 'unknown_code' };
  if (affiliate.status !== 'active') return { status: 'ignored', reason: 'partner_suspended' };

  const settings = await getSettings();
  const emailFp = input.customer.email ? fingerprint(input.customer.email) : undefined;
  const phoneFp = input.customer.phone ? fingerprint(input.customer.phone.replace(/^\+?91/, '')) : undefined;

  // Risk checks: anything suspicious waits for a person instead of being auto-released.
  const flags: { code: 'self_referral' | 'high_value' | 'repeat_customer'; message: string }[] = [];
  if ((emailFp && emailFp === affiliate.emailFp) || (phoneFp && phoneFp === affiliate.phoneFp)) {
    flags.push({ code: 'self_referral', message: "The shopper's email or phone matches the partner's own" });
  }
  if (input.total >= settings.highValueOrder) {
    flags.push({ code: 'high_value', message: `Order total ${formatInr(input.total)} is above the ${formatInr(settings.highValueOrder)} review limit` });
  }
  if (emailFp || phoneFp) {
    const recent = await Order.countDocuments({
      affiliateId: affiliate._id,
      placedAt: { $gte: addDays(input.placedAt, -30) },
      $or: [...(emailFp ? [{ 'customer.emailFp': emailFp }] : []), ...(phoneFp ? [{ 'customer.phoneFp': phoneFp }] : [])],
    });
    if (recent + 1 >= REPEAT_CUSTOMER_LIMIT) {
      flags.push({ code: 'repeat_customer', message: `Same shopper has used this code ${recent + 1} times in 30 days` });
    }
  }

  // Commission is earned on what the shopper paid for products: after the partner discount,
  // before shipping and GST.
  const base = Math.max(0, input.subtotal - input.discount);
  const amount = applyBps(base, settings.commissionRateBps);
  const holdUntil = addDays(input.placedAt, settings.holdDays);

  try {
    return await withTransaction(async (session) => {
      const [order] = await Order.create(
        [
          {
            externalId: input.id,
            affiliateId: affiliate._id,
            code,
            placedAt: input.placedAt,
            customer: { emailFp, phoneFp },
            items: input.items,
            subtotal: input.subtotal,
            discount: input.discount,
            shipping: input.shipping,
            tax: input.tax,
            total: input.total,
            source: opts.source ?? 'webhook',
            createdAt: now,
            updatedAt: now,
          },
        ],
        { session, timestamps: false },
      );
      const [commission] = await Commission.create(
        [
          {
            affiliateId: affiliate._id,
            orderId: order._id,
            kind: 'sale',
            base,
            rateBps: settings.commissionRateBps,
            amount,
            status: 'pending',
            holdUntil,
            placedAt: input.placedAt,
            flags,
            history: [
              {
                at: now,
                from: null,
                to: 'pending',
                by: actor,
                note: flags.length ? `Needs review: ${flags.map((f) => f.message).join('; ')}` : `On hold for the ${settings.holdDays}-day return window`,
              },
            ],
            createdAt: now,
            updatedAt: now,
          },
        ],
        { session, timestamps: false },
      );
      await record(
        {
          at: now,
          actor,
          action: flags.length ? 'order.flagged' : 'order.received',
          entity: 'order',
          entityId: String(order._id),
          summary: `Order ${input.id} with ${code}: ${formatInr(input.total)}, commission ${formatInr(amount)}${flags.length ? ` — flagged: ${flags.map((f) => f.code.replace('_', ' ')).join(', ')}` : ''}`,
          meta: { affiliateId: String(affiliate._id), commissionId: String(commission._id) },
        },
        session,
      );
      return { status: 'created' as const, orderId: String(order._id), commissionId: String(commission._id) };
    });
  } catch (err) {
    // Two deliveries of the same order racing each other: the unique index lets exactly one win.
    if ((err as { code?: number }).code === 11000) {
      const order = await Order.findOne({ externalId: input.id }, { _id: 1 }).lean();
      if (order) return duplicateOf(String(order._id));
    }
    throw err;
  }
}

async function duplicateOf(orderId: string): Promise<IngestResult> {
  const c = await Commission.findOne({ orderId, kind: 'sale' }, { _id: 1 }).lean();
  return { status: 'duplicate', orderId, commissionId: c ? String(c._id) : null };
}

/**
 * Applies a refund. `refundedAmount` is cumulative, which makes replays harmless.
 * - Commission still on hold or ready: full refund reverses it; partial refund reduces it.
 * - Commission already in a payout or paid: the money has left, so a negative "clawback"
 *   commission is created and netted against the partner's next payout.
 */
export async function ingestRefund(input: IncomingRefund, opts: { actor?: Actor; now?: Date } = {}) {
  const now = opts.now ?? input.refundedAt ?? new Date();
  const actor: Actor = opts.actor ?? { type: 'webhook', name: 'Store webhook' };

  return withTransaction(async (session) => {
    const order = await Order.findOne({ externalId: input.id }).session(session);
    if (!order) return { status: 'ignored' as const, reason: 'unknown_order' as const };
    const refunded = Math.min(input.refundedAmount, order.total);
    const delta = refunded - order.refundedAmount;
    if (delta <= 0) return { status: 'duplicate' as const };

    const full = refunded >= order.total;
    order.refundedAmount = refunded;
    order.status = full ? 'refunded' : 'partially_refunded';
    await order.save({ session });

    const sale = await Commission.findOne({ orderId: order._id, kind: 'sale' }).session(session);
    if (!sale || sale.status === 'reversed' || sale.status === 'rejected') return { status: 'applied' as const, effect: 'none' as const };

    const original = applyBps(sale.base, sale.rateBps);
    const share = Math.round((original * delta) / order.total);
    const note = `${full ? 'Full' : 'Partial'} refund of ${formatInr(delta)} on order ${order.externalId}`;
    let effect: 'reversed' | 'reduced' | 'clawback';

    if (sale.status === 'pending' || sale.status === 'approved') {
      if (full) {
        await moveCommissions({ ids: [sale._id], from: sale.status, to: 'reversed', actor, at: now, note, session });
        effect = 'reversed';
      } else {
        const newAmount = Math.max(0, sale.amount - share);
        await Commission.updateOne(
          { _id: sale._id },
          { $set: { amount: newAmount }, $push: { history: { at: now, from: sale.status, to: sale.status, by: actor, note: `${note}: commission reduced to ${formatInr(newAmount)}` } } },
          { session },
        );
        effect = 'reduced';
      }
    } else {
      // in_payout or paid: recover the refunded share from the next payout.
      const clawed = await Commission.aggregate<{ total: number }>([
        { $match: { orderId: order._id, kind: 'clawback' } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]).session(session);
      const remaining = sale.amount + (clawed[0]?.total ?? 0);
      const clawAmount = full ? remaining : Math.min(remaining, share);
      if (clawAmount > 0) {
        await Commission.create(
          [
            {
              affiliateId: sale.affiliateId,
              orderId: order._id,
              kind: 'clawback',
              base: 0,
              rateBps: sale.rateBps,
              amount: -clawAmount,
              status: 'approved',
              holdUntil: now,
              placedAt: now,
              history: [{ at: now, from: null, to: 'approved', by: actor, note: `${note} after payout: ${formatInr(clawAmount)} will be deducted from the next payout` }],
            },
          ],
          { session },
        );
      }
      effect = 'clawback';
    }

    await record(
      {
        at: now,
        actor,
        action: 'order.refunded',
        entity: 'order',
        entityId: String(order._id),
        summary: `${note} — commission ${effect === 'clawback' ? 'clawed back from next payout' : effect}`,
        meta: { effect, commissionId: String(sale._id) },
      },
      session,
    );
    return { status: 'applied' as const, effect };
  });
}
