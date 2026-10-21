import { Types, type ClientSession } from 'mongoose';
import { withTransaction } from '../db/connect.js';
import { decrypt } from '../lib/crypto.js';
import { isoWeek, nextPayoutDate } from '../lib/dates.js';
import { ApiError } from '../lib/errors.js';
import { applyBps, formatInr } from '../lib/money.js';
import { Affiliate } from '../models/affiliate.js';
import { Commission, type Actor } from '../models/commission.js';
import { Payout, type PayoutDoc } from '../models/payout.js';
import { record } from './activity.js';
import { moveCommissions } from './commissions.js';
import { getSettings } from './settings.js';

export type BlockReason = 'no_payout_method' | 'below_minimum' | 'suspended' | 'negative_balance';

interface Balance {
  _id: Types.ObjectId; // affiliateId
  balance: number;
  count: number;
  ids: Types.ObjectId[];
}

/** Ready (approved) money per partner, including negative clawbacks. */
async function readyBalances(affiliateIds?: Types.ObjectId[], session?: ClientSession) {
  return Commission.aggregate<Balance>([
    { $match: { status: 'approved', ...(affiliateIds ? { affiliateId: { $in: affiliateIds } } : {}) } },
    { $group: { _id: '$affiliateId', balance: { $sum: '$amount' }, count: { $sum: 1 }, ids: { $push: '$_id' } } },
  ]).session(session ?? null);
}

/**
 * Who gets paid in the next run, and why everyone else doesn't.
 * TDS (Income Tax Act s.194H) is deducted at the configured rate, or the higher no-PAN rate.
 */
export async function buildPreview(now = new Date(), opts: { affiliateIds?: Types.ObjectId[]; session?: ClientSession } = {}) {
  const settings = await getSettings(opts.session);
  const balances = await readyBalances(opts.affiliateIds, opts.session);
  const affiliates = await Affiliate.find({ _id: { $in: balances.map((b) => b._id) } })
    .session(opts.session ?? null)
    .lean();
  const byId = new Map(affiliates.map((a) => [String(a._id), a]));

  const eligible = [];
  const blocked = [];
  for (const b of balances) {
    const a = byId.get(String(b._id));
    if (!a) continue;
    const affiliate = { id: String(a._id), name: a.name, code: a.code };
    let reason: BlockReason | null = null;
    if (a.status !== 'active') reason = 'suspended';
    else if (b.balance < 0) reason = 'negative_balance';
    else if (!a.payoutMethod) reason = 'no_payout_method';
    else if (b.balance < settings.minPayout) reason = 'below_minimum';

    if (reason) {
      blocked.push({ affiliate, balance: b.balance, reason });
      continue;
    }
    const tdsRateBps = a.panEnc ? settings.tdsRateBps : settings.tdsNoPanRateBps;
    const tds = applyBps(b.balance, tdsRateBps);
    eligible.push({
      affiliate,
      method: a.payoutMethod!,
      commissionIds: b.ids,
      commissionCount: b.count,
      gross: b.balance,
      tdsRateBps,
      tds,
      net: b.balance - tds,
    });
  }
  eligible.sort((x, y) => y.net - x.net);
  blocked.sort((x, y) => y.balance - x.balance);
  return { scheduledFor: nextPayoutDate(now, settings.payoutWeekday), eligible, blocked, minPayout: settings.minPayout };
}

export const methodDto = (m: { kind: string; upiId?: string | null; accountName?: string | null; accountNumberLast4?: string | null; ifsc?: string | null }) =>
  m.kind === 'upi'
    ? { type: 'upi' as const, upiId: m.upiId ?? '' }
    : { type: 'bank' as const, accountName: m.accountName ?? '', accountNumberLast4: m.accountNumberLast4 ?? '', ifsc: m.ifsc ?? '' };

export async function previewDto(now = new Date()) {
  const p = await buildPreview(now);
  return {
    scheduledFor: p.scheduledFor,
    minPayout: p.minPayout,
    eligible: p.eligible.map((e) => ({
      affiliate: e.affiliate,
      method: methodDto(e.method),
      commissionCount: e.commissionCount,
      gross: e.gross,
      tdsRatePct: e.tdsRateBps / 100,
      tds: e.tds,
      net: e.net,
    })),
    blocked: p.blocked,
  };
}

async function nextBatchNumber(scheduledFor: string, session: ClientSession) {
  const { year, week } = isoWeek(scheduledFor);
  const prefix = `PO-${year}-W${String(week).padStart(2, '0')}`;
  const sameWeek = await Payout.countDocuments({ number: { $regex: `^${prefix}` } }).session(session);
  return sameWeek ? `${prefix}-${sameWeek + 1}` : prefix;
}

/**
 * Creates a payout batch for the chosen partners, in one transaction:
 * the batch is written and every commission it pays moves from ready to in payout.
 * If any of those commissions changed meanwhile (refund, rejection, another batch), the whole thing
 * is rolled back — a commission can never be in two batches or paid twice.
 */
export async function createBatch(params: { affiliateIds: string[]; actor: Actor; now?: Date }) {
  const now = params.now ?? new Date();
  const ids = [...new Set(params.affiliateIds)].map((id) => new Types.ObjectId(id));

  return withTransaction(async (session) => {
    const preview = await buildPreview(now, { affiliateIds: ids, session });
    if (!preview.eligible.length) {
      throw ApiError.conflict('None of the selected partners can be paid right now. Refresh the preview.');
    }
    const number = await nextBatchNumber(preview.scheduledFor, session);
    const [payout] = await Payout.create(
      [
        {
          number,
          scheduledFor: preview.scheduledFor,
          createdBy: { id: params.actor.id, name: params.actor.name },
          items: preview.eligible.map((e) => ({
            affiliateId: new Types.ObjectId(e.affiliate.id),
            affiliateName: e.affiliate.name,
            code: e.affiliate.code,
            method: {
              kind: e.method.kind,
              upiId: e.method.upiId,
              accountName: e.method.accountName,
              accountNumberEnc: e.method.accountNumberEnc,
              accountNumberLast4: e.method.accountNumberLast4,
              ifsc: e.method.ifsc,
            },
            commissionIds: e.commissionIds,
            gross: e.gross,
            tdsRateBps: e.tdsRateBps,
            tds: e.tds,
            net: e.net,
          })),
        },
      ],
      { session },
    );

    const commissionIds = preview.eligible.flatMap((e) => e.commissionIds);
    const moved = await moveCommissions({
      ids: commissionIds,
      from: 'approved',
      to: 'in_payout',
      actor: params.actor,
      at: now,
      note: `Added to payout ${number}`,
      set: { payoutId: payout._id },
      session,
    });
    if (moved !== commissionIds.length) {
      throw ApiError.conflict('Some balances changed while the batch was being created. Refresh the preview and try again.');
    }

    const totals = batchTotals(payout);
    await record(
      {
        at: now,
        actor: params.actor,
        action: 'payout.created',
        entity: 'payout',
        entityId: String(payout._id),
        summary: `Created ${number}: ${formatInr(totals.net)} to ${totals.items} partner${totals.items === 1 ? '' : 's'} (TDS ${formatInr(totals.tds)})`,
      },
      session,
    );
    return payout;
  });
}

export function batchTotals(p: Pick<PayoutDoc, 'items'>) {
  const items = p.items ?? [];
  return {
    gross: items.reduce((s, i) => s + i.gross, 0),
    tds: items.reduce((s, i) => s + i.tds, 0),
    net: items.reduce((s, i) => s + i.net, 0),
    items: items.length,
    paid: items.filter((i) => i.status === 'paid').length,
    failed: items.filter((i) => i.status === 'failed').length,
  };
}

async function loadPendingItem(payoutId: string, itemId: string, session: ClientSession) {
  const payout = await Payout.findById(payoutId).session(session);
  if (!payout) throw ApiError.notFound('Payout');
  const item = payout.items.id(itemId);
  if (!item) throw ApiError.notFound('Payout item');
  if (item.status !== 'pending') throw ApiError.conflict(`This payment is already marked ${item.status}.`);
  return { payout, item };
}

async function completeIfDone(payout: PayoutDoc, actor: Actor, now: Date, session: ClientSession) {
  if (payout.items.every((i) => i.status !== 'pending')) {
    payout.status = 'completed';
    payout.completedAt = now;
    await payout.save({ session });
    const t = batchTotals(payout);
    await record(
      {
        at: now,
        actor,
        action: 'payout.completed',
        entity: 'payout',
        entityId: String(payout._id),
        summary: `${payout.number} completed: ${t.paid} paid${t.failed ? `, ${t.failed} failed` : ''}`,
      },
      session,
    );
  }
}

/** Records the bank's UTR for one transfer; the commissions it covered become paid. */
export async function markItemPaid(params: { payoutId: string; itemId: string; utr: string; actor: Actor; now?: Date }) {
  const now = params.now ?? new Date();
  const utr = params.utr.trim().toUpperCase();
  return withTransaction(async (session) => {
    const reused = await Payout.exists({ 'items.utr': utr }).session(session);
    if (reused) throw ApiError.conflict('This UTR is already recorded against another payment.', [{ field: 'utr', message: 'UTR already used' }]);
    const { payout, item } = await loadPendingItem(params.payoutId, params.itemId, session);

    item.status = 'paid';
    item.utr = utr;
    item.paidAt = now;
    await payout.save({ session });
    const moved = await moveCommissions({
      ids: item.commissionIds,
      from: 'in_payout',
      to: 'paid',
      actor: params.actor,
      at: now,
      note: `Paid in ${payout.number}, UTR ${utr}`,
      set: { paidAt: now },
      session,
    });
    if (moved !== item.commissionIds.length) throw ApiError.conflict('Commissions in this payment changed unexpectedly. Nothing was saved.');

    await record(
      {
        at: now,
        actor: params.actor,
        action: 'payout.item_paid',
        entity: 'payout',
        entityId: String(payout._id),
        summary: `Paid ${formatInr(item.net)} to ${item.affiliateName} (${item.code}) in ${payout.number}, UTR ${utr}`,
        meta: { affiliateId: String(item.affiliateId) },
      },
      session,
    );
    await completeIfDone(payout, params.actor, now, session);
    return payout;
  });
}

/** A transfer bounced or was rejected: the money goes back to the partner's ready balance. */
export async function markItemFailed(params: { payoutId: string; itemId: string; reason: string; actor: Actor; now?: Date }) {
  const now = params.now ?? new Date();
  return withTransaction(async (session) => {
    const { payout, item } = await loadPendingItem(params.payoutId, params.itemId, session);
    item.status = 'failed';
    item.failureReason = params.reason.trim();
    await payout.save({ session });
    await moveCommissions({
      ids: item.commissionIds,
      from: 'in_payout',
      to: 'approved',
      actor: params.actor,
      at: now,
      note: `Payment in ${payout.number} failed: ${item.failureReason}. Back in the next payout.`,
      set: { payoutId: null },
      session,
    });
    await record(
      {
        at: now,
        actor: params.actor,
        action: 'payout.item_failed',
        entity: 'payout',
        entityId: String(payout._id),
        summary: `Payment of ${formatInr(item.net)} to ${item.affiliateName} (${item.code}) failed: ${item.failureReason}`,
        meta: { affiliateId: String(item.affiliateId) },
      },
      session,
    );
    await completeIfDone(payout, params.actor, now, session);
    return payout;
  });
}

const csvCell = (v: string | number) => {
  const s = String(v);
  // Quote when needed, and neutralise spreadsheet formula injection (=, +, -, @ at the start).
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/**
 * Bank bulk-upload file for the payments still pending in a batch. This is the only place account
 * numbers are decrypted. Columns follow the common Indian bank / RazorpayX bulk-payout layout.
 */
export async function bankFile(payoutId: string, actor: Actor) {
  const payout = await Payout.findById(payoutId).lean();
  if (!payout) throw ApiError.notFound('Payout');
  const header = ['beneficiary_name', 'account_number', 'ifsc', 'upi_id', 'mode', 'amount_inr', 'reference', 'narration'];
  const rows = payout.items
    .filter((i) => i.status === 'pending')
    .map((i) => {
      const m = i.method;
      const isUpi = m.kind === 'upi';
      return [
        isUpi ? i.affiliateName : (m.accountName ?? i.affiliateName),
        isUpi ? '' : m.accountNumberEnc ? decrypt(m.accountNumberEnc) : '',
        isUpi ? '' : (m.ifsc ?? ''),
        isUpi ? (m.upiId ?? '') : '',
        isUpi ? 'UPI' : 'NEFT',
        (i.net / 100).toFixed(2),
        `${payout.number}-${i.code}`,
        `Core Asana partner payout ${payout.number}`,
      ];
    });
  await record({
    actor,
    action: 'payout.bank_file_downloaded',
    entity: 'payout',
    entityId: String(payout._id),
    summary: `Downloaded the bank file for ${payout.number} (${rows.length} payment${rows.length === 1 ? '' : 's'})`,
  });
  const csv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
  return { filename: `${payout.number}-bank-upload.csv`, csv };
}

/**
 * API shape of a batch. For a partner (`onlyAffiliateId`), only their own payment is included and the
 * totals are computed from it alone — partners never see each other's amounts.
 */
export function payoutDto(p: PayoutDoc, opts: { onlyAffiliateId?: string; withItems?: boolean } = {}) {
  const scoped = (p.items ?? []).filter((i) => !opts.onlyAffiliateId || String(i.affiliateId) === opts.onlyAffiliateId);
  const items = scoped
    .map((i) => ({
      id: String(i._id),
      affiliate: { id: String(i.affiliateId), name: i.affiliateName, code: i.code },
      method: methodDto(i.method),
      commissionCount: i.commissionIds.length,
      gross: i.gross,
      tdsRatePct: i.tdsRateBps / 100,
      tds: i.tds,
      net: i.net,
      status: i.status,
      utr: i.utr ?? null,
      failureReason: i.failureReason ?? null,
      paidAt: i.paidAt ?? null,
    }));
  return {
    id: String(p._id),
    number: p.number,
    status: p.status,
    scheduledFor: p.scheduledFor,
    createdAt: p.createdAt,
    completedAt: p.completedAt ?? null,
    createdBy: { name: opts.onlyAffiliateId ? 'Core Asana finance' : (p.createdBy?.name ?? '') },
    totals: batchTotals({ items: scoped } as Pick<PayoutDoc, 'items'>),
    ...(opts.withItems === false ? {} : { items }),
  };
}
