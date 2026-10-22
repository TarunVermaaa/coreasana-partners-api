import { describe, expect, it } from 'vitest';
import { Commission } from '../src/models/commission.js';
import { Order } from '../src/models/order.js';
import { ingestOrder, ingestRefund } from '../src/services/attribution.js';
import { releaseDue } from '../src/services/commissions.js';
import { createBatch, markItemPaid } from '../src/services/payouts.js';
import { days, makeAffiliate, orderFor, webhook } from './helpers.js';

const actor = { type: 'staff' as const, name: 'Finance' };

describe('order webhook', () => {
  it('rejects requests that are not signed by the store', async () => {
    const { affiliate } = await makeAffiliate();
    const body = { event: 'order.created', order: orderFor(affiliate.code) };
    const res = await webhook(body, { signature: 'sha256=deadbeef' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
    expect(await Order.countDocuments()).toBe(0);
  });

  it('turns an order into an on-hold commission: 12% of the discounted product value', async () => {
    const { affiliate } = await makeAffiliate();
    const order = orderFor(affiliate.code.toLowerCase()); // codes are case-insensitive
    const res = await webhook({ event: 'order.created', order });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('created');

    const c = await Commission.findOne().lean();
    expect(c).toMatchObject({ kind: 'sale', status: 'pending', base: 269_010, rateBps: 1200, amount: 32_281 });
    expect(c!.holdUntil.getTime() - new Date(order.placedAt).getTime()).toBe(days(15));
    expect(c!.history).toHaveLength(1);
  });

  it('is idempotent: a redelivered order does not create a second commission', async () => {
    const { affiliate } = await makeAffiliate();
    const body = { event: 'order.created', order: orderFor(affiliate.code) };
    await webhook(body);
    const again = await webhook(body);
    expect(again.body.status).toBe('duplicate');
    // Even two deliveries racing each other end with exactly one order and one commission.
    const raced = { event: 'order.created', order: orderFor(affiliate.code) };
    await Promise.all([webhook(raced), webhook(raced), webhook(raced)]);
    expect(await Order.countDocuments()).toBe(2);
    expect(await Commission.countDocuments()).toBe(2);
  });

  it('acknowledges orders with unknown codes without creating anything', async () => {
    const res = await webhook({ event: 'order.created', order: orderFor('NOSUCHCODE') });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ignored', reason: 'unknown_code' });
    expect(await Order.countDocuments()).toBe(0);
  });

  it('rejects orders dated in the future or discounted below zero', async () => {
    const { affiliate } = await makeAffiliate();
    const future = await webhook({ event: 'order.created', order: orderFor(affiliate.code, { placedAt: new Date('2099-01-01') }) });
    expect(future.status).toBe(400);
    expect(future.body.error.details[0].field).toBe('order.placedAt');
    const overDiscount = await webhook({ event: 'order.created', order: orderFor(affiliate.code, { discount: 400_000 }) });
    expect(overDiscount.status).toBe(400);
    expect(await Order.countDocuments()).toBe(0);
  });

  it('rejects malformed payloads with field errors', async () => {
    const res = await webhook({ event: 'order.created', order: { id: 'X1', code: 'ABCD' } });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain('order.total');
  });
});

describe('risk flags', () => {
  it('flags a partner buying with their own code and keeps it out of auto-release', async () => {
    const { affiliate } = await makeAffiliate({ email: 'teacher@example.com' });
    await ingestOrder(orderFor(affiliate.code, { customer: { email: 'Teacher@Example.com ' } }));
    const c = await Commission.findOne().lean();
    expect(c!.flags.map((f) => f.code)).toEqual(['self_referral']);

    const result = await releaseDue(new Date('2026-12-01'));
    expect(result.released).toBe(0);
    expect((await Commission.findOne().lean())!.status).toBe('pending');
  });

  it('flags unusually large orders', async () => {
    const { affiliate } = await makeAffiliate();
    await ingestOrder(orderFor(affiliate.code, { items: [{ name: 'AcuTech Mat Pro', qty: 8, price: 298_900 }], subtotal: 2_391_200, discount: 239_120, total: 2_152_080 }));
    expect((await Commission.findOne().lean())!.flags.map((f) => f.code)).toEqual(['high_value']);
  });
});

describe('refunds', () => {
  it('reverses a commission refunded inside the return window', async () => {
    const { affiliate } = await makeAffiliate();
    const order = orderFor(affiliate.code);
    await ingestOrder(order);
    const res = await webhook({ event: 'order.refunded', order: { id: order.id, refundedAmount: order.total } });
    expect(res.body).toEqual({ status: 'applied', effect: 'reversed' });
    expect((await Commission.findOne().lean())!.status).toBe('reversed');
    // Replaying the same refund changes nothing.
    expect((await webhook({ event: 'order.refunded', order: { id: order.id, refundedAmount: order.total } })).body.status).toBe('duplicate');
  });

  it('reduces the commission for a partial refund', async () => {
    const { affiliate } = await makeAffiliate();
    const order = orderFor(affiliate.code);
    await ingestOrder(order);
    await ingestRefund({ id: order.id, refundedAmount: Math.round(order.total / 2) });
    const c = await Commission.findOne().lean();
    expect(c!.status).toBe('pending');
    expect(c!.amount).toBe(32_281 - 16_141);
  });

  it('claws back a refund that arrives after the commission was paid', async () => {
    const { affiliate } = await makeAffiliate();
    const order = orderFor(affiliate.code, { placedAt: new Date('2026-09-01T10:00:00Z') });
    await ingestOrder(order);
    await ingestOrder(orderFor(affiliate.code, { placedAt: new Date('2026-09-01T11:00:00Z') })); // reach the ₹500 minimum
    await releaseDue(new Date('2026-09-20'));
    const batch = await createBatch({ affiliateIds: [String(affiliate._id)], actor, now: new Date('2026-09-25T06:00:00Z') });
    await markItemPaid({ payoutId: String(batch._id), itemId: String(batch.items[0]._id), utr: 'HDFCN26268123456', actor });

    const res = await ingestRefund({ id: order.id, refundedAmount: order.total });
    expect(res).toEqual({ status: 'applied', effect: 'clawback' });
    const claw = await Commission.findOne({ kind: 'clawback' }).lean();
    expect(claw).toMatchObject({ status: 'approved', amount: -32_281 });
    expect((await Commission.findOne({ kind: 'sale' }).lean())!.status).toBe('paid');
  });
});
