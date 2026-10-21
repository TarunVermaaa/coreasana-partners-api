import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

export const AUDIENCES = ['teacher', 'studio', 'physio', 'creator', 'other'] as const;
export type Audience = (typeof AUDIENCES)[number];

// Where a partner wants to be paid. Account number and PAN are encrypted at rest (lib/crypto.ts);
// only the last 4 characters are kept in clear for display.
const payoutMethodSchema = new Schema(
  {
    kind: { type: String, enum: ['upi', 'bank'], required: true },
    upiId: String,
    accountName: String,
    accountNumberEnc: String,
    accountNumberLast4: String,
    ifsc: String,
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const affiliateSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true, unique: true },
    phone: { type: String, required: true, unique: true }, // normalised +91XXXXXXXXXX
    passwordHash: { type: String, required: true, select: false },
    code: { type: String, required: true, uppercase: true, unique: true },
    audience: { type: String, enum: AUDIENCES, required: true },
    city: { type: String, trim: true },
    instagram: { type: String, trim: true },
    status: { type: String, enum: ['active', 'suspended'], default: 'active', index: true },
    payoutMethod: { type: payoutMethodSchema, default: null },
    panEnc: { type: String, default: null },
    panLast4: { type: String, default: null },
    // Fingerprints of the partner's own email/phone, compared with shoppers' to flag self-referrals.
    emailFp: { type: String, index: true },
    phoneFp: { type: String, index: true },
  },
  { timestamps: true },
);

export type AffiliateFields = InferSchemaType<typeof affiliateSchema>;
export type AffiliateDoc = HydratedDocument<AffiliateFields>;
export const Affiliate = model('Affiliate', affiliateSchema);
