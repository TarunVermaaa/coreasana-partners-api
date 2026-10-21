import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { env } from '../config/env.js';
import { ApiError } from '../lib/errors.js';
import { pctToBps, rupees } from '../lib/money.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';
import { valid, validate } from '../middleware/validate.js';
import { Settings } from '../models/misc.js';
import { Order } from '../models/order.js';
import { Payout } from '../models/payout.js';
import { record, listActivity } from '../services/activity.js';
import { affiliateDetail, commissionTotals, commissionView, listAffiliates, overview, setAffiliateStatus } from '../services/admin.js';
import { listCommissions } from '../services/affiliates.js';
import { ingestOrder, ingestRefund } from '../services/attribution.js';
import { releaseDue, reviewCommissions } from '../services/commissions.js';
import { bankFile, createBatch, markItemFailed, markItemPaid, payoutDto, previewDto } from '../services/payouts.js';
import { getSettings } from '../services/settings.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole('ops', 'finance'));

const objectId = z.string().regex(/^[0-9a-f]{24}$/, 'Not a valid id');
const IdParams = z.object({ id: objectId });
const ops = requireRole('ops'); // affiliate team (admin passes every staff check)
const finance = requireRole('finance');

// ---------- Overview ----------
adminRouter.get('/overview', async (_req, res) => {
  res.json(await overview());
});

// ---------- Partners ----------
const AffiliateListSchema = z.object({
  search: z.string().trim().max(80).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: objectId.optional(),
});
adminRouter.get('/affiliates', validate('query', AffiliateListSchema), async (req, res) => {
  res.json(await listAffiliates(valid(req, 'query')));
});
adminRouter.get('/affiliates/:id', validate('params', IdParams), async (req, res) => {
  res.json(await affiliateDetail(valid<{ id: string }>(req, 'params').id));
});
adminRouter.patch(
  '/affiliates/:id',
  ops,
  validate('params', IdParams),
  validate('body', z.object({ status: z.enum(['active', 'suspended']) })),
  async (req, res) => {
    const { id } = valid<{ id: string }>(req, 'params');
    res.json(await setAffiliateStatus(id, valid<{ status: 'active' | 'suspended' }>(req, 'body').status, actorOf(req)));
  },
);

// ---------- Commissions (affiliate team) ----------
const CommissionListSchema = z.object({
  view: z.enum(['needs_review', 'on_hold', 'due', 'ready', 'in_payout', 'paid', 'reversed', 'all']).default('all'),
  affiliateId: objectId.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: objectId.optional(),
});
adminRouter.get('/commissions', validate('query', CommissionListSchema), async (req, res) => {
  const q = valid<z.infer<typeof CommissionListSchema>>(req, 'query');
  const filter = commissionView(q.view, new Date());
  if (q.affiliateId) filter.affiliateId = new Types.ObjectId(q.affiliateId);
  const [page, totals] = await Promise.all([
    listCommissions({ filter, limit: q.limit, cursor: q.cursor, includeAffiliate: true }),
    commissionTotals(filter),
  ]);
  res.json({ ...page, totals });
});

const ReviewSchema = z.object({
  ids: z.array(objectId).min(1).max(200),
  decision: z.enum(['approve', 'reject']),
  note: z.string().trim().max(300).optional(),
});
adminRouter.post('/commissions/review', ops, validate('body', ReviewSchema), async (req, res) => {
  const body = valid<z.infer<typeof ReviewSchema>>(req, 'body');
  res.json(await reviewCommissions({ ids: body.ids.map((id) => new Types.ObjectId(id)), decision: body.decision, note: body.note, actor: actorOf(req) }));
});

adminRouter.post('/commissions/release-due', ops, async (req, res) => {
  res.json(await releaseDue(new Date(), actorOf(req)));
});

// ---------- Payouts (finance) ----------
adminRouter.get('/payouts/preview', finance, async (_req, res) => {
  res.json(await previewDto());
});

adminRouter.post('/payouts', finance, validate('body', z.object({ affiliateIds: z.array(objectId).min(1).max(5000) })), async (req, res) => {
  const payout = await createBatch({ affiliateIds: valid<{ affiliateIds: string[] }>(req, 'body').affiliateIds, actor: actorOf(req) });
  res.status(201).json(payoutDto(payout));
});

adminRouter.get('/payouts', async (_req, res) => {
  const rows = await Payout.find().sort({ createdAt: -1 }).limit(50);
  res.json({ items: rows.map((p) => payoutDto(p, { withItems: false })) });
});

adminRouter.get('/payouts/:id', validate('params', IdParams), async (req, res) => {
  const p = await Payout.findById(valid<{ id: string }>(req, 'params').id);
  if (!p) throw ApiError.notFound('Payout');
  res.json(payoutDto(p));
});

adminRouter.get('/payouts/:id/bank-file', finance, validate('params', IdParams), async (req, res) => {
  const { filename, csv } = await bankFile(valid<{ id: string }>(req, 'params').id, actorOf(req));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store'); // contains account numbers
  res.send(csv);
});

const ItemParams = z.object({ id: objectId, itemId: objectId });
adminRouter.post(
  '/payouts/:id/items/:itemId/paid',
  finance,
  validate('params', ItemParams),
  validate('body', z.object({ utr: z.string().trim().regex(/^[A-Za-z0-9]{10,22}$/, 'UTRs are 10–22 letters or numbers') })),
  async (req, res) => {
    const { id, itemId } = valid<{ id: string; itemId: string }>(req, 'params');
    res.json(payoutDto(await markItemPaid({ payoutId: id, itemId, utr: valid<{ utr: string }>(req, 'body').utr, actor: actorOf(req) })));
  },
);
adminRouter.post(
  '/payouts/:id/items/:itemId/failed',
  finance,
  validate('params', ItemParams),
  validate('body', z.object({ reason: z.string().trim().min(3, 'Say what the bank reported').max(200) })),
  async (req, res) => {
    const { id, itemId } = valid<{ id: string; itemId: string }>(req, 'params');
    res.json(payoutDto(await markItemFailed({ payoutId: id, itemId, reason: valid<{ reason: string }>(req, 'body').reason, actor: actorOf(req) })));
  },
);

// ---------- Activity ----------
const ActivitySchema = z.object({
  entityId: z.string().max(40).optional(),
  entity: z.enum(['affiliate', 'order', 'commission', 'payout', 'settings']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().datetime().optional(),
});
adminRouter.get('/activity', validate('query', ActivitySchema), async (req, res) => {
  res.json(await listActivity(valid(req, 'query')));
});

// ---------- Settings ----------
const settingsDto = (s: Awaited<ReturnType<typeof getSettings>>) => ({
  commissionRatePct: s.commissionRateBps / 100,
  customerDiscountPct: s.customerDiscountPct,
  holdDays: s.holdDays,
  minPayoutInr: s.minPayout / 100,
  tdsRatePct: s.tdsRateBps / 100,
  tdsNoPanRatePct: s.tdsNoPanRateBps / 100,
  highValueOrderInr: s.highValueOrder / 100,
  payoutWeekday: s.payoutWeekday,
});
adminRouter.get('/settings', async (_req, res) => {
  res.json(settingsDto(await getSettings()));
});
const SettingsSchema = z.object({
  commissionRatePct: z.number().min(0).max(50).optional(),
  customerDiscountPct: z.number().min(0).max(50).optional(),
  holdDays: z.number().int().min(0).max(60).optional(),
  minPayoutInr: z.number().min(0).max(100_000).optional(),
  tdsRatePct: z.number().min(0).max(30).optional(),
  tdsNoPanRatePct: z.number().min(0).max(30).optional(),
  highValueOrderInr: z.number().min(0).optional(),
});
adminRouter.patch('/settings', requireRole('admin'), validate('body', SettingsSchema), async (req, res) => {
  const b = valid<z.infer<typeof SettingsSchema>>(req, 'body');
  const set: Record<string, number> = {};
  if (b.commissionRatePct !== undefined) set.commissionRateBps = pctToBps(b.commissionRatePct);
  if (b.customerDiscountPct !== undefined) set.customerDiscountPct = b.customerDiscountPct;
  if (b.holdDays !== undefined) set.holdDays = b.holdDays;
  if (b.minPayoutInr !== undefined) set.minPayout = rupees(b.minPayoutInr);
  if (b.tdsRatePct !== undefined) set.tdsRateBps = pctToBps(b.tdsRatePct);
  if (b.tdsNoPanRatePct !== undefined) set.tdsNoPanRateBps = pctToBps(b.tdsNoPanRatePct);
  if (b.highValueOrderInr !== undefined) set.highValueOrder = rupees(b.highValueOrderInr);
  const before = await getSettings();
  await Settings.updateOne({ key: 'program' }, { $set: set });
  const after = await getSettings();
  // New terms apply to orders from now on; existing commissions keep the rate they were earned at.
  await record({
    actor: actorOf(req),
    action: 'settings.updated',
    entity: 'settings',
    summary: `Updated program terms: ${Object.keys(b).join(', ')}`,
    meta: { before: settingsDto(before), after: settingsDto(after) },
  });
  res.json(settingsDto(after));
});

// ---------- Demo tools (simulate store events without a real store) ----------
const PRODUCTS = [
  { sku: 'ACU-PRO-LAV', name: 'AcuTech Mat Pro', price: 298_900 },
  { sku: 'MOD-CUSH-MID', name: 'Mod Meditation Cushion', price: 169_900 },
  { sku: 'BOL-MINI-VER', name: 'Mini Rectangular Bolster', price: 149_900 },
  { sku: 'MAT-COT-AMB', name: 'Cotton Mat', price: 179_900 },
];
const DemoOrderSchema = z.object({
  code: z.string().trim().min(4).max(12),
  items: z.array(z.object({ name: z.string().min(1), qty: z.number().int().min(1).max(20), price: z.number().int().min(0) })).optional(),
  customerEmail: z.string().trim().optional(),
  placedDaysAgo: z.number().min(0).max(90).default(0),
});
adminRouter.post('/demo/orders', ops, validate('body', DemoOrderSchema), async (req, res) => {
  if (!env.DEMO_TOOLS) throw ApiError.forbidden('Demo tools are turned off');
  const b = valid<z.infer<typeof DemoOrderSchema>>(req, 'body');
  const items = b.items?.length ? b.items : [{ ...PRODUCTS[Math.floor(Math.random() * PRODUCTS.length)], qty: 1 }];
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  const { customerDiscountPct } = await getSettings();
  const discount = Math.round((subtotal * customerDiscountPct) / 100);
  const result = await ingestOrder(
    {
      id: `CA-DEMO-${Date.now().toString(36).toUpperCase()}`,
      placedAt: new Date(Date.now() - b.placedDaysAgo * 86_400_000),
      code: b.code,
      customer: { email: b.customerEmail || `shopper.${Date.now()}@example.com` },
      items,
      subtotal,
      discount,
      // Prices on the store include GST, so the demo order has no separate tax line.
      shipping: 0,
      tax: 0,
      total: subtotal - discount,
    },
    { source: 'demo', actor: actorOf(req) },
  );
  if (result.status === 'ignored') {
    throw ApiError.validation([{ field: 'code', message: result.reason === 'unknown_code' ? 'No partner uses this code' : 'This partner is paused' }]);
  }
  res.status(201).json(result);
});

adminRouter.post('/demo/refund', ops, validate('body', z.object({ externalId: z.string().min(1), amount: z.number().int().positive().optional() })), async (req, res) => {
  if (!env.DEMO_TOOLS) throw ApiError.forbidden('Demo tools are turned off');
  const b = valid<{ externalId: string; amount?: number }>(req, 'body');
  const order = await Order.findOne({ externalId: b.externalId }).lean();
  if (!order) throw ApiError.notFound('Order');
  res.json(await ingestRefund({ id: b.externalId, refundedAmount: Math.min(order.total, order.refundedAmount + (b.amount ?? order.total)) }, { actor: actorOf(req) }));
});

export const DEMO_PRODUCTS = PRODUCTS;
