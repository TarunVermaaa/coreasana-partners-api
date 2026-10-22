import { Router } from 'express';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import { auth, requireAuth, requireRole } from '../middleware/auth.js';
import { valid, validate } from '../middleware/validate.js';
import { getAffiliate, listCommissions, payoutsFor, setPayoutMethod, summary, updateProfile, type PayoutMethodInput } from '../services/affiliates.js';
import { affiliateDto } from '../services/dto.js';

/** Everything a signed-in partner can see and change — always scoped to their own id. */
export const meRouter = Router();
meRouter.use(requireAuth, requireRole('affiliate'));

// A paused partner can still see what they earned and were paid, but can't change anything:
// their session may predate the pause, so this is checked on every write.
meRouter.use(async (req, _res, next) => {
  if (req.method === 'GET') return next();
  const a = await getAffiliate(auth(req).id);
  if (a.status !== 'active') return next(ApiError.forbidden('This partner account is paused. Write to partners@coreasana.com.'));
  next();
});

meRouter.get('/', async (req, res) => {
  res.json(affiliateDto(await getAffiliate(auth(req).id)));
});

const ProfileSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  city: z.string().trim().max(60).optional(),
  instagram: z.string().trim().max(60).optional(),
});
meRouter.patch('/', validate('body', ProfileSchema), async (req, res) => {
  res.json(await updateProfile(auth(req).id, valid(req, 'body')));
});

const pan = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'PAN looks like ABCDE1234F')
  .optional()
  .or(z.literal('').transform(() => undefined));

const PayoutMethodSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('upi'),
    upiId: z.string().trim().regex(/^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$/, 'UPI IDs look like name@bank'),
    pan,
  }),
  z.object({
    type: z.literal('bank'),
    accountName: z.string().trim().min(2, 'Enter the name on the account').max(80),
    accountNumber: z.string().trim().regex(/^\d{9,18}$/, 'Account numbers are 9–18 digits'),
    ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC looks like HDFC0001234'),
    pan,
  }),
]);
meRouter.put('/payout-method', validate('body', PayoutMethodSchema), async (req, res) => {
  res.json(await setPayoutMethod(auth(req).id, valid<PayoutMethodInput>(req, 'body')));
});

meRouter.get('/summary', async (req, res) => {
  res.json(await summary(auth(req).id));
});

const STATUS_FILTER: Record<string, unknown> = {
  pending: 'pending',
  approved: 'approved',
  in_payout: 'in_payout',
  paid: 'paid',
  reversed: { $in: ['reversed', 'rejected'] },
  rejected: 'rejected',
};
const ListSchema = z.object({
  status: z.enum(['pending', 'approved', 'in_payout', 'paid', 'reversed', 'rejected']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().regex(/^[0-9a-f]{24}$/).optional(),
});
meRouter.get('/commissions', validate('query', ListSchema), async (req, res) => {
  const q = valid<z.infer<typeof ListSchema>>(req, 'query');
  res.json(
    await listCommissions({
      affiliateId: auth(req).id,
      filter: q.status ? { status: STATUS_FILTER[q.status] } : {},
      limit: q.limit,
      cursor: q.cursor,
    }),
  );
});

meRouter.get('/payouts', async (req, res) => {
  res.json(await payoutsFor(auth(req).id));
});
