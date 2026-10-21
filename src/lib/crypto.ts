import crypto from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Field-level encryption for payout PII (bank account numbers, PAN).
 * AES-256-GCM: a random 12-byte IV per value, and the auth tag detects tampering.
 * Stored as "v1:<iv>:<tag>:<ciphertext>" (base64), so the key or scheme can be rotated later.
 * Only finance's bank file decrypts account numbers; everything else shows the last 4 digits.
 */
const key = Buffer.from(env.PII_ENCRYPTION_KEY, 'hex');

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function decrypt(stored: string): string {
  const [version, iv, tag, data] = stored.split(':');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unsupported encrypted value');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

/**
 * One-way fingerprint of a customer's email/phone. Lets us spot self-referrals and repeat customers
 * without storing the shopper's contact details.
 */
export function fingerprint(value: string): string {
  const normalised = value.trim().toLowerCase().replace(/[\s-]/g, '');
  return crypto.createHmac('sha256', key).update(normalised).digest('hex');
}

/** Constant-time comparison for webhook signatures. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
