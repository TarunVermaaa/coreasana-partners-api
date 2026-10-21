import supertest from 'supertest';
import { createApp } from '../src/app.js';
import { encrypt, fingerprint } from '../src/lib/crypto.js';
import { signToken } from '../src/middleware/auth.js';
import { Affiliate } from '../src/models/affiliate.js';
import { Staff } from '../src/models/staff.js';
import type { IncomingOrder } from '../src/services/attribution.js';
import { signPayload } from '../src/routes/webhooks.js';

export const app = createApp();
export const http = () => supertest(app);

let n = 0;
export async function makeAffiliate(overrides: Partial<{ code: string; email: string; phone: string; status: 'active' | 'suspended'; upi: string | null; bank: boolean; pan: string | null }> = {}) {
  n += 1;
  const email = overrides.email ?? `partner${n}@example.com`;
  const phone = overrides.phone ?? `98765${String(10000 + n).slice(-5)}`;
  const upi = overrides.upi === undefined ? `partner${n}@okhdfcbank` : overrides.upi;
  const a = await Affiliate.create({
    name: `Partner ${n}`,
    email,
    phone: `+91${phone}`,
    passwordHash: 'x',
    code: overrides.code ?? `PART${n}0`,
    audience: 'teacher',
    status: overrides.status ?? 'active',
    emailFp: fingerprint(email),
    phoneFp: fingerprint(phone),
    payoutMethod: overrides.bank
      ? { kind: 'bank', accountName: `Partner ${n}`, accountNumberEnc: encrypt('123456789012'), accountNumberLast4: '9012', ifsc: 'HDFC0001234' }
      : upi
        ? { kind: 'upi', upiId: upi }
        : null,
    panEnc: overrides.pan === null ? null : encrypt(overrides.pan ?? 'ABCDE1234F'),
    panLast4: overrides.pan === null ? null : '234F',
  });
  return { affiliate: a, token: signToken({ id: String(a._id), role: 'affiliate', name: a.name }) };
}

export async function staffToken(role: 'ops' | 'finance' | 'admin') {
  const s = await Staff.create({ name: `${role} person`, email: `${role}${++n}@example.com`, passwordHash: 'x', role });
  return signToken({ id: String(s._id), role, name: s.name });
}

let orderNo = 1000;
/** A store order: one AcuTech Mat Pro (₹2,989) with the 10% partner discount. */
export function orderFor(code: string, overrides: Partial<IncomingOrder> = {}): IncomingOrder {
  return {
    id: `CA-${orderNo++}`,
    placedAt: new Date('2026-10-01T10:00:00Z'),
    code,
    customer: { email: `shopper${orderNo}@example.com` },
    items: [{ name: 'AcuTech Mat Pro', qty: 1, price: 298_900 }],
    subtotal: 298_900,
    discount: 29_890,
    shipping: 0,
    tax: 0,
    total: 269_010,
    ...overrides,
  };
}

export function webhook(body: unknown, opts: { signature?: string } = {}) {
  const raw = JSON.stringify(body);
  return http()
    .post('/api/v1/webhooks/orders')
    .set('content-type', 'application/json')
    .set('x-coreasana-signature', opts.signature ?? signPayload(raw))
    .send(raw);
}

export const days = (d: number) => d * 86_400_000;
