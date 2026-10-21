import { Router } from 'express';
import { env } from '../config/env.js';
import { istDay } from '../lib/dates.js';
import { logger } from '../lib/logger.js';
import { Affiliate } from '../models/affiliate.js';
import { ClickDay } from '../models/misc.js';
import { normaliseCode } from '../services/affiliates.js';

export const redirectRouter = Router();

/**
 * Partner share links: <PUBLIC_API_URL>/r/PRIYA10.
 * Counts the click (one upsert per partner per day), then sends the shopper to the store with the
 * code in the URL so the store can pre-apply the discount. The shopper is redirected even if
 * counting fails — a lost click must never become a lost sale.
 */
redirectRouter.get('/r/:code', async (req, res) => {
  const code = normaliseCode(String(req.params.code));
  const target = new URL(env.STORE_URL);
  try {
    const affiliate = await Affiliate.findOne({ code, status: 'active' }, { _id: 1 }).lean();
    if (affiliate) {
      target.searchParams.set('ref', code);
      target.searchParams.set('utm_source', 'partner');
      target.searchParams.set('utm_campaign', code);
      await ClickDay.updateOne({ affiliateId: affiliate._id, day: istDay(new Date()) }, { $inc: { count: 1 } }, { upsert: true });
    }
  } catch (err) {
    logger.warn('Click tracking failed', { code, error: String(err) });
  }
  res.redirect(302, target.toString());
});
