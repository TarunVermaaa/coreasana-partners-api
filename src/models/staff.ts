import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * Internal users. Roles follow the teams in the brief, with separation of duties:
 * - ops: the affiliate team — reviews and releases commissions, manages partners
 * - finance: creates and settles payout batches
 * - admin: everything, plus program settings and demo tools
 */
export const STAFF_ROLES = ['ops', 'finance', 'admin'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

const staffSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true, unique: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: STAFF_ROLES, required: true },
  },
  { timestamps: true },
);

export type StaffFields = InferSchemaType<typeof staffSchema>;
export type StaffDoc = HydratedDocument<StaffFields>;
export const Staff = model('Staff', staffSchema);
