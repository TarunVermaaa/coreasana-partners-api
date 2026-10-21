import type { ClientSession, Types } from 'mongoose';
import { ApiError } from '../lib/errors.js';
import { formatInr } from '../lib/money.js';
import { Commission, TRANSITIONS, type Actor, type CommissionStatus } from '../models/commission.js';
import { record, SYSTEM } from './activity.js';

interface MoveParams {
  ids: Types.ObjectId[];
  from: CommissionStatus;
  to: CommissionStatus;
  actor: Actor;
  note?: string;
  at?: Date;
  set?: Record<string, unknown>;
  session?: ClientSession;
}

/**
 * The single way a commission changes status.
 * - Rejects moves the state machine doesn't allow (models/commission.ts TRANSITIONS).
 * - The update only matches documents still in `from`, so concurrent actions can't double-apply:
 *   whoever comes second simply matches nothing.
 * - Appends a history entry in the same write.
 * Returns how many commissions actually moved.
 */
export async function moveCommissions({ ids, from, to, actor, note, at = new Date(), set = {}, session }: MoveParams) {
  if (!TRANSITIONS[from].includes(to)) throw new Error(`Illegal commission transition ${from} → ${to}`);
  if (!ids.length) return 0;
  const res = await Commission.updateMany(
    { _id: { $in: ids }, status: from },
    { $set: { status: to, ...set }, $push: { history: { at, from, to, by: actor, note } } },
    { session },
  );
  return res.modifiedCount;
}

/**
 * Moves commissions whose return window has ended from on hold to ready.
 * Flagged commissions are left for a person to review — they are never auto-released.
 */
export async function releaseDue(now = new Date(), actor: Actor = SYSTEM) {
  const due = await Commission.find(
    { status: 'pending', kind: 'sale', holdUntil: { $lte: now }, 'flags.0': { $exists: false } },
    { _id: 1, amount: 1 },
  ).lean();
  if (!due.length) return { released: 0, amount: 0 };

  const released = await moveCommissions({
    ids: due.map((c) => c._id),
    from: 'pending',
    to: 'approved',
    actor,
    at: now,
    note: 'Return window ended with no refund',
  });
  const amount = due.reduce((sum, c) => sum + c.amount, 0);
  if (released) {
    await record({
      at: now,
      actor,
      action: 'commission.released',
      entity: 'commission',
      summary: `Released ${released} commission${released === 1 ? '' : 's'} (${formatInr(amount)}) after the return window`,
      meta: { count: released, amount },
    });
  }
  return { released, amount };
}

/**
 * Affiliate team decision on one or more commissions.
 * - approve: any on-hold commission. Approving before the return window ends needs a note
 *   (e.g. "delivered, customer confirmed"), because a refund could still arrive.
 * - reject: on hold or ready, always with a note — the partner sees the reason.
 */
export async function reviewCommissions(params: {
  ids: Types.ObjectId[];
  decision: 'approve' | 'reject';
  note?: string;
  actor: Actor;
  now?: Date;
}) {
  const { ids, decision, actor } = params;
  const now = params.now ?? new Date();
  const note = params.note?.trim() || undefined;
  const docs = await Commission.find({ _id: { $in: ids } }, { status: 1, holdUntil: 1, amount: 1, kind: 1 }).lean();
  if (docs.length !== ids.length) throw ApiError.notFound('One or more commissions');

  const review = { decision, note, by: actor, at: now };
  let updated = 0;
  let amount = 0;

  if (decision === 'approve') {
    const notPending = docs.filter((d) => d.status !== 'pending');
    if (notPending.length) throw ApiError.conflict(`${notPending.length} of these commissions are no longer on hold. Refresh and try again.`);
    const early = docs.some((d) => d.holdUntil > now);
    if (early && !note) {
      throw ApiError.validation([{ field: 'note', message: 'Add a note to approve before the return window ends' }]);
    }
    updated = await moveCommissions({ ids, from: 'pending', to: 'approved', actor, at: now, note: note ?? 'Approved after review', set: { review } });
    amount = docs.reduce((s, d) => s + d.amount, 0);
  } else {
    if (!note) throw ApiError.validation([{ field: 'note', message: 'Add a reason — the partner will see it' }]);
    const bad = docs.filter((d) => d.status !== 'pending' && d.status !== 'approved');
    if (bad.length) throw ApiError.conflict(`${bad.length} of these commissions are already in a payout or closed.`);
    for (const from of ['pending', 'approved'] as const) {
      const group = docs.filter((d) => d.status === from).map((d) => d._id);
      updated += await moveCommissions({ ids: group, from, to: 'rejected', actor, at: now, note, set: { review } });
    }
    amount = docs.reduce((s, d) => s + d.amount, 0);
  }

  await record({
    at: now,
    actor,
    action: decision === 'approve' ? 'commission.approved' : 'commission.rejected',
    entity: 'commission',
    entityId: ids.length === 1 ? String(ids[0]) : undefined,
    summary: `${decision === 'approve' ? 'Approved' : 'Rejected'} ${updated} commission${updated === 1 ? '' : 's'} (${formatInr(amount)})${note ? `: ${note}` : ''}`,
    meta: { ids: ids.map(String), note },
  });
  return { updated };
}
