import bcrypt from 'bcryptjs';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { dbState } from '../db/connect.js';
import { ApiError } from '../lib/errors.js';
import { auth, requireAuth, requireRole, signToken } from '../middleware/auth.js';
import { valid, validate } from '../middleware/validate.js';
import { AUDIENCES } from '../models/affiliate.js';
import { Staff } from '../models/staff.js';
import { codeAvailability, signup, verifyAffiliateLogin } from '../services/affiliates.js';
import { affiliateDto } from '../services/dto.js';
import { programTerms } from '../services/settings.js';
import { isTest } from '../config/env.js';

export const publicRouter = Router();

const limitHandler = (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
  res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please wait a few minutes and try again.' } });

// Brute-force protection on credentials; generous enough for a real person mistyping.
const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: isTest ? 1000 : 20, handler: limitHandler });
// The code field checks availability as the partner types.
const codeLimiter = rateLimit({ windowMs: 60_000, limit: isTest ? 1000 : 60, handler: limitHandler });

publicRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok', db: dbState() });
});

publicRouter.get('/program', async (_req, res) => {
  res.json(await programTerms());
});

publicRouter.get('/codes/:code/availability', codeLimiter, async (req, res) => {
  res.json(await codeAvailability(String(req.params.code)));
});

const SignupSchema = z.object({
  name: z.string().trim().min(2, 'Enter your full name').max(80),
  email: z.string().trim().toLowerCase().pipe(z.email('Enter a valid email')),
  phone: z.string().trim().min(10, 'Enter a 10-digit mobile number').max(20, 'Enter a 10-digit mobile number'),
  password: z.string().min(8, 'Use at least 8 characters').max(72),
  audience: z.enum(AUDIENCES, { error: 'Choose how you will share Core Asana' }),
  code: z.string().trim().min(4, 'Use 4–12 letters or numbers').max(12, 'Use 4–12 letters or numbers'),
  city: z.string().trim().max(60).optional(),
  instagram: z.string().trim().max(60).optional(),
});

publicRouter.post('/auth/affiliate/signup', authLimiter, validate('body', SignupSchema), async (req, res) => {
  const affiliate = await signup(valid(req, 'body'));
  res.status(201).json({ token: signToken({ id: affiliate.id, role: 'affiliate', name: affiliate.name }), affiliate });
});

const LoginSchema = z.object({
  email: z.string().trim().min(1, 'Enter your email'),
  password: z.string().min(1, 'Enter your password'),
});

publicRouter.post('/auth/affiliate/login', authLimiter, validate('body', LoginSchema), async (req, res) => {
  const { email, password } = valid<z.infer<typeof LoginSchema>>(req, 'body');
  const a = await verifyAffiliateLogin(email, password);
  res.json({ token: signToken({ id: String(a._id), role: 'affiliate', name: a.name }), affiliate: affiliateDto(a) });
});

publicRouter.post('/auth/staff/login', authLimiter, validate('body', LoginSchema), async (req, res) => {
  const { email, password } = valid<z.infer<typeof LoginSchema>>(req, 'body');
  const s = await Staff.findOne({ email: email.trim().toLowerCase() }).select('+passwordHash').lean();
  if (!s || !(await bcrypt.compare(password, s.passwordHash))) throw ApiError.unauthenticated('Email or password is incorrect');
  const staff = { id: String(s._id), name: s.name, email: s.email, role: s.role };
  res.json({ token: signToken({ id: staff.id, role: s.role, name: s.name }), staff });
});

publicRouter.get('/auth/staff/me', requireAuth, requireRole('ops', 'finance'), async (req, res) => {
  const s = await Staff.findById(auth(req).id).lean();
  if (!s) throw ApiError.unauthenticated();
  res.json({ id: String(s._id), name: s.name, email: s.email, role: s.role });
});
