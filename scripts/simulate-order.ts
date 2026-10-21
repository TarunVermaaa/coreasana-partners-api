/**
 * Plays the store: sends a signed order webhook, exactly as the Core Asana store would.
 *
 *   npm run simulate:order -- PRIYA10                 # one AcuTech Mat Pro with the partner code
 *   npm run simulate:order -- PRIYA10 --qty 2         # two of them
 *   npm run simulate:order -- --refund CA-SIM-XXXX    # full refund of an earlier order
 *
 * Uses API_URL (default http://localhost:4100) and WEBHOOK_SECRET from .env.
 */
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const apiUrl = (process.env.API_URL ?? process.env.PUBLIC_API_URL ?? 'http://localhost:4100').replace(/\/$/, '');
const secret = process.env.WEBHOOK_SECRET ?? 'dev-only-webhook_secret-change-me';

async function send(body: unknown) {
  const raw = JSON.stringify(body);
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  const res = await fetch(`${apiUrl}/api/v1/webhooks/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-coreasana-signature': signature },
    body: raw,
  });
  console.log(res.status, await res.text());
}

const refundId = flag('refund');
if (refundId) {
  await send({ event: 'order.refunded', order: { id: refundId, refundedAmount: Number(flag('amount') ?? 1e12), refundedAt: new Date().toISOString() } });
} else {
  const code = args.find((a) => !a.startsWith('--'));
  if (!code) {
    console.error('Usage: npm run simulate:order -- <PARTNER_CODE> [--qty N]');
    process.exit(1);
  }
  const qty = Number(flag('qty') ?? 1);
  const price = 298_900; // AcuTech Mat Pro, ₹2,989 (GST inclusive)
  const subtotal = price * qty;
  const discount = Math.round(subtotal * 0.1);
  const id = `CA-SIM-${Date.now().toString(36).toUpperCase()}`;
  await send({
    event: 'order.created',
    order: {
      id,
      placedAt: new Date().toISOString(),
      code,
      customer: { email: `shopper.${Date.now()}@example.com` },
      items: [{ sku: 'ACU-PRO-LAV', name: 'AcuTech Mat Pro', qty, price }],
      subtotal,
      discount,
      shipping: 0,
      tax: 0,
      total: subtotal - discount,
    },
  });
  console.log(`Order id: ${id} (refund it with: npm run simulate:order -- --refund ${id})`);
}
