import bcrypt from 'bcryptjs';
import { Types } from 'mongoose';
import { env } from '../config/env.js';
import { encrypt, fingerprint } from '../lib/crypto.js';
import { addDays, istDay } from '../lib/dates.js';
import { ApiError } from '../lib/errors.js';
import { applyBps } from '../lib/money.js';
import { Affiliate, type Audience } from '../models/affiliate.js';
import { Commission, type CommissionStatus } from '../models/commission.js';
import { ClickDay } from '../models/misc.js';
import { Order } from '../models/order.js';
import { Payout } from '../models/payout.js';
import { record } from './activity.js';
import { affiliateDto, hydrateCommissions } from './dto.js';
import { buildPreview, payoutDto } from './payouts.js';
import { getSettings } from './settings.js';

// ---------- Partner codes ----------
export const CODE_PATTERN = /^[A-Z0-9]{4,12}$/;
// Codes that would confuse shoppers or look official.
const RESERVED = new Set(['ADMIN', 'TEST', 'COREASANA', 'ASANA', 'FREE', 'DISCOUNT', 'SALE', 'OFFER', 'COUPON', 'STAFF', 'NULL']);

export function normaliseCode(raw: string) {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function codeProblem(code: string): string | null {
  if (!CODE_PATTERN.test(code)) return 'Use 4–12 letters or numbers';
  if (RESERVED.has(code)) return 'This word is reserved';
  return null;
}

/** Is a code free, and if not, what similar ones are? Suggestions are checked against the database. */
export async function codeAvailability(raw: string) {
  const code = normaliseCode(raw);
  const problem = codeProblem(code);
  const taken = problem ? false : Boolean(await Affiliate.exists({ code }));
  const available = !problem && !taken;

  let suggestions: string[] = [];
  if (!available) {
    const stem = (code.replace(/\d+$/, '') || 'PARTNER').slice(0, 9);
    const candidates = [`${stem}10`, `${stem}YOGA`, `${stem}11`, `${stem}12`, `${stem}26`, `${stem}CA`].filter((c) => c !== code && !codeProblem(c));
    const used = new Set((await Affiliate.find({ code: { $in: candidates } }, { code: 1 }).lean()).map((a) => a.code));
    suggestions = candidates.filter((c) => !used.has(c)).slice(0, 3);
  }
  return { code, available, reason: problem ?? (taken ? 'Someone already uses this code' : undefined), suggestions };
}

// ---------- Signup / login ----------
export function normalisePhone(raw: string) {
  const digits = raw.replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');
  return digits.length === 10 ? `+91${digits}` : null;
}

export async function signup(input: {
  name: string;
  email: string;
  phone: string;
  password: string;
  audience: Audience;
  code: string;
  city?: string;
  instagram?: string;
}) {
  const phone = normalisePhone(input.phone);
  if (!phone) throw ApiError.validation([{ field: 'phone', message: 'Enter a 10-digit Indian mobile number' }]);
  const code = normaliseCode(input.code);
  const problem = codeProblem(code);
  if (problem) throw ApiError.validation([{ field: 'code', message: problem }]);
  const email = input.email.trim().toLowerCase();

  // Report every clash at once, so the form can show them together.
  const clashes = await Affiliate.find({ $or: [{ email }, { phone }, { code }] }, { email: 1, phone: 1, code: 1 }).lean();
  const details = [];
  if (clashes.some((c) => c.email === email)) details.push({ field: 'email', message: 'An account with this email already exists. Log in instead.' });
  if (clashes.some((c) => c.phone === phone)) details.push({ field: 'phone', message: 'This number is already registered' });
  if (clashes.some((c) => c.code === code)) details.push({ field: 'code', message: 'Someone already uses this code' });
  if (details.length) throw ApiError.conflict('Some details are already in use', details);

  const affiliate = await Affiliate.create({
    name: input.name.trim(),
    email,
    phone,
    passwordHash: await bcrypt.hash(input.password, 10),
    code,
    audience: input.audience,
    city: input.city?.trim() || undefined,
    instagram: input.instagram?.trim().replace(/^@/, '') || undefined,
    emailFp: fingerprint(email),
    phoneFp: fingerprint(phone.slice(3)),
  });
  await record({
    actor: { type: 'affiliate', id: String(affiliate._id), name: affiliate.name },
    action: 'affiliate.joined',
    entity: 'affiliate',
    entityId: String(affiliate._id),
    summary: `${affiliate.name} joined as a ${input.audience} partner with code ${code}`,
  });
  return affiliateDto(affiliate.toObject());
}

export async function verifyAffiliateLogin(email: string, password: string) {
  const a = await Affiliate.findOne({ email: email.trim().toLowerCase() }).select('+passwordHash').lean();
  // Same message for unknown email and wrong password: don't reveal which emails are registered.
  if (!a || !(await bcrypt.compare(password, a.passwordHash))) throw ApiError.unauthenticated('Email or password is incorrect');
  if (a.status === 'suspended') throw ApiError.forbidden('This partner account is paused. Write to partners@coreasana.com.');
  return a;
}

// ---------- Profile & payout details ----------
export async function getAffiliate(id: string) {
  const a = await Affiliate.findById(id).lean();
  if (!a) throw ApiError.notFound('Partner');
  return a;
}

export async function updateProfile(id: string, patch: { name?: string; city?: string; instagram?: string }) {
  const a = await Affiliate.findByIdAndUpdate(
    id,
    { $set: { ...patch, ...(patch.instagram !== undefined ? { instagram: patch.instagram.replace(/^@/, '') } : {}) } },
    { new: true, runValidators: true },
  ).lean();
  if (!a) throw ApiError.notFound('Partner');
  return affiliateDto(a);
}

export type PayoutMethodInput =
  | { type: 'upi'; upiId: string; pan?: string }
  | { type: 'bank'; accountName: string; accountNumber: string; ifsc: string; pan?: string };

export async function setPayoutMethod(id: string, input: PayoutMethodInput) {
  const payoutMethod =
    input.type === 'upi'
      ? { kind: 'upi', upiId: input.upiId.trim().toLowerCase(), updatedAt: new Date() }
      : {
          kind: 'bank',
          accountName: input.accountName.trim(),
          accountNumberEnc: encrypt(input.accountNumber),
          accountNumberLast4: input.accountNumber.slice(-4),
          ifsc: input.ifsc.toUpperCase(),
          updatedAt: new Date(),
        };
  const set: Record<string, unknown> = { payoutMethod };
  if (input.pan) {
    set.panEnc = encrypt(input.pan.toUpperCase());
    set.panLast4 = input.pan.slice(-4).toUpperCase();
  }
  const a = await Affiliate.findByIdAndUpdate(id, { $set: set }, { new: true }).lean();
  if (!a) throw ApiError.notFound('Partner');
  await record({
    actor: { type: 'affiliate', id, name: a.name },
    action: 'affiliate.payout_method_updated',
    entity: 'affiliate',
    entityId: id,
    summary: `${a.name} updated payout details (${input.type === 'upi' ? 'UPI' : `bank ••${payoutMethod.accountNumberLast4}`})${input.pan ? ' and PAN' : ''}`,
  });
  return affiliateDto(a);
}

// ---------- Earnings ----------
const STATUS_KEYS: Record<CommissionStatus, 'onHold' | 'ready' | 'inPayout' | 'paidTotal' | 'reversedTotal'> = {
  pending: 'onHold',
  approved: 'ready',
  in_payout: 'inPayout',
  paid: 'paidTotal',
  reversed: 'reversedTotal',
  rejected: 'reversedTotal',
};

export async function balancesFor(affiliateId: Types.ObjectId) {
  const rows = await Commission.aggregate<{ _id: CommissionStatus; amount: number }>([
    { $match: { affiliateId } },
    { $group: { _id: '$status', amount: { $sum: '$amount' } } },
  ]);
  const balances = { onHold: 0, ready: 0, inPayout: 0, paidTotal: 0, reversedTotal: 0 };
  for (const r of rows) balances[STATUS_KEYS[r._id]] += r.amount;
  return balances;
}

const BLOCKER_TEXT = {
  no_payout_method: 'Add your UPI ID or bank account to get paid',
  below_minimum: 'Payouts start once your ready balance reaches the minimum',
  suspended: 'Your account is paused',
  negative_balance: 'A refund after your last payout is being recovered first',
} as const;

export async function summary(affiliateId: string, now = new Date()) {
  const id = new Types.ObjectId(affiliateId);
  const [affiliate, settings, balances, preview, recentRows, clicks, orders] = await Promise.all([
    getAffiliate(affiliateId),
    getSettings(),
    balancesFor(id),
    buildPreview(now, { affiliateIds: [id] }),
    Commission.find({ affiliateId: id }).sort({ _id: -1 }).limit(5).lean(),
    ClickDay.aggregate<{ total: number }>([
      { $match: { affiliateId: id, day: { $gte: istDay(addDays(now, -30)) } } },
      { $group: { _id: null, total: { $sum: '$count' } } },
    ]),
    Order.aggregate<{ orders: number; sales: number }>([
      { $match: { affiliateId: id, placedAt: { $gte: addDays(now, -30) } } },
      { $group: { _id: null, orders: { $sum: 1 }, sales: { $sum: '$total' } } },
    ]),
  ]);
  const earned30 = await Commission.aggregate<{ total: number }>([
    { $match: { affiliateId: id, kind: 'sale', status: { $nin: ['reversed', 'rejected'] }, placedAt: { $gte: addDays(now, -30) } } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);

  const eligible = preview.eligible[0];
  const blocked = preview.blocked[0];
  const tdsRateBps = affiliate.panEnc ? settings.tdsRateBps : settings.tdsNoPanRateBps;
  const blockers: string[] = [];
  if (!affiliate.payoutMethod) blockers.push(BLOCKER_TEXT.no_payout_method);
  if (blocked && blocked.reason !== 'no_payout_method') blockers.push(BLOCKER_TEXT[blocked.reason]);
  if (!eligible && !blocked && balances.ready <= 0) blockers.push('Nothing is ready to pay yet');

  return {
    balances,
    nextPayout: {
      date: preview.scheduledFor,
      estimatedNet: eligible ? eligible.net : Math.max(0, balances.ready - applyBps(Math.max(0, balances.ready), tdsRateBps)),
      eligible: Boolean(eligible),
      blockers,
      minPayout: settings.minPayout,
      tdsRatePct: tdsRateBps / 100,
    },
    stats30d: {
      clicks: clicks[0]?.total ?? 0,
      orders: orders[0]?.orders ?? 0,
      sales: orders[0]?.sales ?? 0,
      earned: earned30[0]?.total ?? 0,
    },
    shareUrl: `${env.PUBLIC_API_URL.replace(/\/$/, '')}/r/${affiliate.code}`,
    recent: await hydrateCommissions(recentRows),
  };
}

export async function listCommissions(params: {
  affiliateId?: string;
  filter: Record<string, unknown>;
  limit: number;
  cursor?: string;
  includeAffiliate?: boolean;
}) {
  const query: Record<string, unknown> = { ...params.filter };
  if (params.affiliateId) query.affiliateId = new Types.ObjectId(params.affiliateId);
  if (params.cursor) query._id = { $lt: new Types.ObjectId(params.cursor) };
  const rows = await Commission.find(query).sort({ _id: -1 }).limit(params.limit + 1).lean();
  const page = rows.slice(0, params.limit);
  return {
    items: await hydrateCommissions(page, { includeAffiliate: params.includeAffiliate }),
    nextCursor: rows.length > params.limit ? String(page[page.length - 1]._id) : null,
  };
}

export async function payoutsFor(affiliateId: string) {
  const rows = await Payout.find({ 'items.affiliateId': new Types.ObjectId(affiliateId) }).sort({ createdAt: -1 }).limit(50);
  return { items: rows.map((p) => payoutDto(p, { onlyAffiliateId: affiliateId })) };
}

