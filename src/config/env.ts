import { z } from 'zod';

const isProd = process.env.NODE_ENV === 'production';

// Development and tests get safe local defaults; production must set every secret explicitly.
const devSecret = (name: string) => (isProd ? z.string().min(16, `${name} must be at least 16 characters`) : z.string().min(16).default(`dev-only-${name.toLowerCase()}-change-me`));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4100),
  MONGODB_URI: z.string().min(1).default('mongodb://localhost:27017/coreasana_partners?replicaSet=rs0&directConnection=true'),
  JWT_SECRET: devSecret('JWT_SECRET'),
  WEBHOOK_SECRET: devSecret('WEBHOOK_SECRET'),
  PII_ENCRYPTION_KEY: isProd
    ? z.string().regex(/^[0-9a-fA-F]{64}$/, 'PII_ENCRYPTION_KEY must be 32 bytes of hex (64 characters)')
    : z.string().regex(/^[0-9a-fA-F]{64}$/).default('0'.repeat(64)),
  PUBLIC_API_URL: z.string().url().default('http://localhost:4100'),
  STORE_URL: z.string().url().default('https://coreasana.com'),
  CORS_ORIGINS: z.string().default('http://localhost:5180,http://localhost:8081'),
  SEED_ON_BOOT: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  DEMO_TOOLS: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  RELEASE_JOB_INTERVAL_MIN: z.coerce.number().positive().default(15),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast with a readable message instead of crashing later on a missing value.
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const corsOrigins = env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
