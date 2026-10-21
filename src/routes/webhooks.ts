import crypto from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { safeEqual } from '../lib/crypto.js';
import { ApiError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { valid, validate } from '../middleware/validate.js';
import { IncomingOrderSchema, IncomingRefundSchema, ingestOrder, ingestRefund } from '../services/attribution.js';

export const webhooksRouter = Router();

export function signPayload(raw: string | Buffer) {
  return `sha256=${crypto.createHmac('sha256', env.WEBHOOK_SECRET).update(raw).digest('hex')}`;
}

/**
 * Only the store can create orders: it signs the exact request body with the shared secret
 * (HMAC-SHA256, like Shopify/Razorpay webhooks) and we compare in constant time.
 */
function verifySignature(req: Request, _res: Response, next: NextFunction) {
  const header = req.header('x-coreasana-signature') ?? '';
  if (!req.rawBody || !safeEqual(header, signPayload(req.rawBody))) {
    return next(new ApiError(401, 'INVALID_SIGNATURE', 'Webhook signature does not match'));
  }
  next();
}

const WebhookSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('order.created'), order: IncomingOrderSchema }),
  z.object({ event: z.literal('order.refunded'), order: IncomingRefundSchema }),
]);

/**
 * Store → API order events. Always answers 200 for events we understood, including duplicates and
 * orders with unknown codes, so the store doesn't retry them forever; 4xx only for bad signatures
 * or malformed payloads.
 */
webhooksRouter.post('/orders', verifySignature, validate('body', WebhookSchema), async (req, res) => {
  const body = valid<z.infer<typeof WebhookSchema>>(req, 'body');
  const result = body.event === 'order.created' ? await ingestOrder(body.order) : await ingestRefund(body.order);
  if (result.status === 'ignored') logger.warn('Webhook order ignored', { event: body.event, id: body.order.id, reason: result.reason });
  res.json(result);
});
