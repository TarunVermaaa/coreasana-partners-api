import { describe, expect, it } from 'vitest';
import { Affiliate } from '../src/models/affiliate.js';
import { Commission } from '../src/models/commission.js';
import { Payout } from '../src/models/payout.js';
import { ingestOrder, ingestRefund } from '../src/services/attribution.js';
import { releaseDue, reviewCommissions } from '../src/services/commissions.js';
import { bankFile, buildPreview, createBatch, markItemFailed, markItemPaid } from '../src/services/payouts.js';
import { makeAffiliate, orderFor } from './helpers.js';

const actor = { type: 'staff' as const, name: 'Rohan (finance)' };
const PLACED = new Date('2026-09-01T10:00:00Z');
const AFTER_HOLD = new Date('2026-09-20T00:00:00Z');
const FRIDAY = new Date('2026-09-25T06:00:00Z');

/** Two ready orders (₹322.81 each) for a partner. */
async function readyPartner(opts: Parameters<typeof makeAffiliate>[0] = {}, orders = 2) {
  const p = await makeAffiliate(opts);
  for (let i = 0; i < orders; i++) await ingestOrder(orderFor(p.affiliate.code, { placedAt: PLACED }));
  await releaseDue(AFTER_HOLD);
  return p;
}

describe('payout preview', () => {
  it('pays partners above the minimum and explains everyone it skips', async () => {
    const ok = await readyPartner();
    const noMethod = await readyPartner({ upi: null });
    const small = await readyPartner({}, 1); // ₹322.81 < ₹500 minimum
    const paused = await readyPartner();
    await Affiliate.updateOne({ _id: paused.affiliate._id }, { status: 'suspended' }); // paused after earning

    const p = await buildPreview(FRIDAY);
    expect(p.scheduledFor).toBe('2026-09-25');
    expect(p.eligible.map((e) => e.affiliate.code)).toEqual([ok.affiliate.code]);
    const reasons = Object.fromEntries(p.blocked.map((b) => [b.affiliate.code, b.reason]));
    expect(reasons).toEqual({
      [noMethod.affiliate.code]: 'no_payout_method',
      [small.affiliate.code]: 'below_minimum',
      [paused.affiliate.code]: 'suspended',
    });
  });

  it('deducts 2% TDS with a PAN on file and 20% without', async () => {
    const withPan = await readyPartner();
    const noPan = await readyPartner({ pan: null });
    const p = await buildPreview(FRIDAY);
    const by = Object.fromEntries(p.eligible.map((e) => [e.affiliate.code, e]));
    expect(by[withPan.affiliate.code]).toMatchObject({ gross: 64_562, tdsRateBps: 200, tds: 1_291, net: 63_271 });
    expect(by[noPan.affiliate.code]).toMatchObject({ gross: 64_562, tdsRateBps: 2000, tds: 12_912, net: 51_650 });
  });

  it('nets a clawback against the next payout', async () => {
    const p = await readyPartner({}, 3);
    const order = orderFor(p.affiliate.code, { placedAt: PLACED });
    await ingestOrder(order);
    await releaseDue(AFTER_HOLD);
    const batch = await createBatch({ affiliateIds: [String(p.affiliate._id)], actor, now: FRIDAY });
    await markItemPaid({ payoutId: String(batch._id), itemId: String(batch.items[0]._id), utr: '612345678901', actor });
    await ingestRefund({ id: order.id, refundedAmount: order.total });
    // New sales after the refund: 3 × 322.81 = 968.43, minus the 322.81 clawback.
    for (let i = 0; i < 3; i++) await ingestOrder(orderFor(p.affiliate.code, { placedAt: new Date('2026-09-26T10:00:00Z') }));
    await releaseDue(new Date('2026-10-15'));
    const next = await buildPreview(new Date('2026-10-16T06:00:00Z'));
    expect(next.eligible[0].gross).toBe(3 * 32_281 - 32_281);
  });
});

describe('payout batches', () => {
  it('locks the commissions it pays, so nothing can be paid twice', async () => {
    const a = await readyPartner();
    const b = await readyPartner({ bank: true });
    const batch = await createBatch({ affiliateIds: [String(a.affiliate._id), String(b.affiliate._id)], actor, now: FRIDAY });

    expect(batch.number).toBe('PO-2026-W39');
    expect(batch.items).toHaveLength(2);
    expect(await Commission.countDocuments({ status: 'in_payout', payoutId: batch._id })).toBe(4);
    // A second run finds nothing left to pay.
    await expect(createBatch({ affiliateIds: [String(a.affiliate._id)], actor, now: FRIDAY })).rejects.toMatchObject({ status: 409 });
  });

  it('lets only one of two simultaneous batch requests through', async () => {
    const a = await readyPartner();
    const results = await Promise.allSettled([
      createBatch({ affiliateIds: [String(a.affiliate._id)], actor, now: FRIDAY }),
      createBatch({ affiliateIds: [String(a.affiliate._id)], actor, now: FRIDAY }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await Payout.countDocuments()).toBe(1);
    expect(await Commission.countDocuments({ status: 'in_payout' })).toBe(2);
  });

  it('marks commissions paid with the UTR and completes the batch', async () => {
    const a = await readyPartner();
    const batch = await createBatch({ affiliateIds: [String(a.affiliate._id)], actor, now: FRIDAY });
    const done = await markItemPaid({ payoutId: String(batch._id), itemId: String(batch.items[0]._id), utr: 'hdfcn26268123456', actor });

    expect(done.status).toBe('completed');
    expect(done.items[0]).toMatchObject({ status: 'paid', utr: 'HDFCN26268123456' });
    const paid = await Commission.find({ status: 'paid' }).lean();
    expect(paid).toHaveLength(2);
    expect(paid[0].history.at(-1)!.note).toContain('HDFCN26268123456');
    // Paying the same item again, or reusing the UTR, is refused.
    await expect(markItemPaid({ payoutId: String(batch._id), itemId: String(batch.items[0]._id), utr: 'OTHER1234567', actor })).rejects.toMatchObject({ status: 409 });
  });

  it('returns money to the ready balance when a transfer fails', async () => {
    const a = await readyPartner({ bank: true });
    const batch = await createBatch({ affiliateIds: [String(a.affiliate._id)], actor, now: FRIDAY });
    await markItemFailed({ payoutId: String(batch._id), itemId: String(batch.items[0]._id), reason: 'Account closed', actor });

    const back = await Commission.find({ status: 'approved' }).lean();
    expect(back).toHaveLength(2);
    expect(back.every((c) => c.payoutId === null)).toBe(true);
    expect((await buildPreview(FRIDAY)).eligible[0].gross).toBe(64_562);
  });

  it('writes a bank upload file with full account numbers, safe for spreadsheets', async () => {
    const a = await readyPartner({ bank: true });
    const b = await readyPartner({ upi: '=cmd@ybl' });
    const batch = await createBatch({ affiliateIds: [String(a.affiliate._id), String(b.affiliate._id)], actor, now: FRIDAY });
    const { csv, filename } = await bankFile(String(batch._id), actor);
    const lines = csv.trim().split('\n');

    expect(filename).toBe('PO-2026-W39-bank-upload.csv');
    expect(lines[0]).toBe('beneficiary_name,account_number,ifsc,upi_id,mode,amount_inr,reference,narration');
    expect(csv).toContain('123456789012,HDFC0001234,,NEFT,632.71');
    expect(csv).toContain("'=cmd@ybl"); // formula injection neutralised
  });
});

describe('commission review', () => {
  it('needs a note to approve before the return window ends, and to reject', async () => {
    const { affiliate } = await makeAffiliate();
    await ingestOrder(orderFor(affiliate.code, { placedAt: new Date('2026-10-20T10:00:00Z') }));
    const c = await Commission.findOne().lean();
    const now = new Date('2026-10-21T10:00:00Z');

    await expect(reviewCommissions({ ids: [c!._id], decision: 'approve', actor, now })).rejects.toMatchObject({ status: 400 });
    await expect(reviewCommissions({ ids: [c!._id], decision: 'reject', actor, now })).rejects.toMatchObject({ status: 400 });
    await reviewCommissions({ ids: [c!._id], decision: 'approve', note: 'Delivered, customer confirmed', actor, now });
    expect((await Commission.findById(c!._id).lean())!.status).toBe('approved');
    // A second decision on the same commission is a conflict, not a silent overwrite.
    await expect(reviewCommissions({ ids: [c!._id], decision: 'approve', note: 'again', actor, now })).rejects.toMatchObject({ status: 409 });
  });
});
