import { describe, expect, it } from 'vitest';
import { Affiliate } from '../src/models/affiliate.js';
import { ClickDay } from '../src/models/misc.js';
import { ingestOrder } from '../src/services/attribution.js';
import { http, makeAffiliate, orderFor, staffToken } from './helpers.js';

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe('access control', () => {
  it('requires a session for partner and staff routes', async () => {
    expect((await http().get('/api/v1/me')).status).toBe(401);
    expect((await http().get('/api/v1/admin/overview')).status).toBe(401);
    expect((await http().get('/api/v1/me').set(bearer('not-a-token'))).status).toBe(401);
  });

  it('keeps partners out of staff routes and staff out of partner routes', async () => {
    const { token } = await makeAffiliate();
    const ops = await staffToken('ops');
    expect((await http().get('/api/v1/admin/overview').set(bearer(token))).status).toBe(403);
    expect((await http().get('/api/v1/me').set(bearer(ops))).status).toBe(403);
  });

  it('separates duties: the affiliate team approves, finance pays, admin can do both', async () => {
    const ops = await staffToken('ops');
    const finance = await staffToken('finance');
    const admin = await staffToken('admin');
    const body = { ids: ['0123456789abcdef01234567'], decision: 'approve', note: 'ok' };

    expect((await http().post('/api/v1/admin/payouts').set(bearer(ops)).send({ affiliateIds: ['0123456789abcdef01234567'] })).status).toBe(403);
    expect((await http().get('/api/v1/admin/payouts/preview').set(bearer(ops))).status).toBe(403);
    expect((await http().post('/api/v1/admin/commissions/review').set(bearer(finance)).send(body)).status).toBe(403);
    expect((await http().get('/api/v1/admin/payouts/preview').set(bearer(finance))).status).toBe(200);
    expect((await http().get('/api/v1/admin/payouts/preview').set(bearer(admin))).status).toBe(200);
    // Admin passes the role check (404 here because the commission doesn't exist).
    expect((await http().post('/api/v1/admin/commissions/review').set(bearer(admin)).send(body)).status).toBe(404);
  });

  it('shows partners only their own commissions and payouts', async () => {
    const mine = await makeAffiliate();
    const theirs = await makeAffiliate();
    await ingestOrder(orderFor(mine.affiliate.code));
    await ingestOrder(orderFor(theirs.affiliate.code));
    await ingestOrder(orderFor(theirs.affiliate.code));

    const res = await http().get('/api/v1/me/commissions').set(bearer(mine.token));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).not.toHaveProperty('affiliate');
  });
});

describe('partner signup', () => {
  const valid = { name: 'Zoya Mirza', email: 'zoya@example.com', phone: '98100 99887', password: 'Secret@123', audience: 'teacher', code: 'zoya10' };

  it('creates the account, normalises phone and code, and returns a session', async () => {
    const res = await http().post('/api/v1/auth/affiliate/signup').send(valid);
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.affiliate).toMatchObject({ code: 'ZOYA10', phone: '+919810099887', status: 'active', payoutMethod: null });
    expect(res.body.affiliate).not.toHaveProperty('passwordHash');
  });

  it('accepts the ways people type Indian mobile numbers, and rejects ones that cannot exist', async () => {
    const ok = await http().post('/api/v1/auth/affiliate/signup').send({ ...valid, phone: '+91 0 98100 99887' });
    expect(ok.status).toBe(201);
    expect(ok.body.affiliate.phone).toBe('+919810099887');
    const fake = await http().post('/api/v1/auth/affiliate/signup').send({ ...valid, email: 'fake@example.com', phone: '0000000000', code: 'FAKE10' });
    expect(fake.status).toBe(400);
    expect(fake.body.error.details[0].field).toBe('phone');
  });

  it('reports every field problem at once', async () => {
    const res = await http().post('/api/v1/auth/affiliate/signup').send({ name: 'Z', email: 'nope', phone: '12', password: 'x', audience: 'guru', code: 'a' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { field: string }) => d.field).sort()).toEqual(['audience', 'code', 'email', 'name', 'password', 'phone']);
  });

  it('explains which details are already taken', async () => {
    await http().post('/api/v1/auth/affiliate/signup').send(valid);
    const res = await http().post('/api/v1/auth/affiliate/signup').send({ ...valid, email: 'ZOYA@example.com' });
    expect(res.status).toBe(409);
    expect(res.body.error.details.map((d: { field: string }) => d.field)).toEqual(['email', 'phone', 'code']);
  });

  it('suggests free codes when one is taken', async () => {
    await makeAffiliate({ code: 'PRIYA10' });
    await makeAffiliate({ code: 'PRIYAYOGA' });
    const res = await http().get('/api/v1/codes/priya10/availability');
    expect(res.body).toMatchObject({ code: 'PRIYA10', available: false });
    expect(res.body.suggestions).toEqual(['PRIYA11', 'PRIYA12', 'PRIYA26']);
  });
});

describe('stale sessions', () => {
  it('signs out a partner whose account no longer exists instead of failing with 404', async () => {
    const { affiliate, token } = await makeAffiliate();
    await Affiliate.deleteOne({ _id: affiliate._id });
    const res = await http().get('/api/v1/me').set(bearer(token));
    expect(res.status).toBe(401);
  });
});

describe('earnings calculator', () => {
  it('uses the median order, so one huge order does not inflate the promise', async () => {
    const { affiliate } = await makeAffiliate();
    const placedAt = new Date(Date.now() - 86_400_000);
    for (let i = 0; i < 6; i++) await ingestOrder(orderFor(affiliate.code, { placedAt }));
    await ingestOrder(orderFor(affiliate.code, { placedAt, subtotal: 50_000_000, discount: 0, total: 50_000_000, items: [{ name: 'Bulk', qty: 1, price: 50_000_000 }] }));
    const res = await http().get('/api/v1/program');
    expect(res.body.averageOrderValue).toBe(269_000);
  });
});

describe('paused partners', () => {
  it('can still read their earnings but cannot change payout details', async () => {
    const { affiliate, token } = await makeAffiliate();
    await Affiliate.updateOne({ _id: affiliate._id }, { status: 'suspended' });
    expect((await http().get('/api/v1/me/summary').set(bearer(token))).status).toBe(200);
    const res = await http().put('/api/v1/me/payout-method').set(bearer(token)).send({ type: 'upi', upiId: 'someone@okaxis' });
    expect(res.status).toBe(403);
  });
});

describe('payout details', () => {
  it('validates UPI, IFSC and PAN formats and never returns the full account number', async () => {
    const { token } = await makeAffiliate({ upi: null, pan: null });
    const bad = await http().put('/api/v1/me/payout-method').set(bearer(token)).send({ type: 'bank', accountName: 'Z', accountNumber: '12', ifsc: 'HDFC1234', pan: 'XYZ' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.map((d: { field: string }) => d.field).sort()).toEqual(['accountName', 'accountNumber', 'ifsc', 'pan']);

    const ok = await http()
      .put('/api/v1/me/payout-method')
      .set(bearer(token))
      .send({ type: 'bank', accountName: 'Zoya Mirza', accountNumber: '50200012345678', ifsc: 'hdfc0001234', pan: 'abcde1234f' });
    expect(ok.status).toBe(200);
    expect(ok.body.payoutMethod).toEqual({ type: 'bank', accountName: 'Zoya Mirza', accountNumberLast4: '5678', ifsc: 'HDFC0001234' });
    expect(ok.body.panLast4).toBe('234F');
    expect(JSON.stringify(ok.body)).not.toContain('50200012345678');
  });
});

describe('request limits', () => {
  it('answers 413 for oversized bodies and 400 for an empty settings change', async () => {
    const big = await http().post('/api/v1/auth/affiliate/login').set('content-type', 'application/json').send(JSON.stringify({ email: 'a'.repeat(210_000), password: 'x' }));
    expect(big.status).toBe(413);
    const admin = await staffToken('admin');
    expect((await http().patch('/api/v1/admin/settings').set(bearer(admin)).send({})).status).toBe(400);
  });
});

describe('share links', () => {
  it('counts the click and sends the shopper to the store with the code', async () => {
    const { affiliate } = await makeAffiliate({ code: 'MEHER10' });
    const res = await http().get('/r/meher10');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://coreasana.com/?ref=MEHER10&utm_source=partner&utm_campaign=MEHER10');
    expect((await ClickDay.findOne({ affiliateId: affiliate._id }).lean())!.count).toBe(1);
  });

  it('still sends shoppers to the store for unknown codes', async () => {
    const res = await http().get('/r/nobody');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://coreasana.com/');
  });
});
