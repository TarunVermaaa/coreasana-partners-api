import { Schema, Types, model, type InferSchemaType } from 'mongoose';

const actorSchema = new Schema(
  {
    type: { type: String, enum: ['system', 'staff', 'webhook', 'affiliate'], required: true },
    id: String,
    name: { type: String, required: true },
  },
  { _id: false },
);

/** Append-only audit trail of everything people and the system did. */
const activitySchema = new Schema({
  at: { type: Date, required: true, index: -1 },
  actor: { type: actorSchema, required: true },
  action: { type: String, required: true }, // e.g. "commission.approved", "payout.created"
  entity: { type: String, enum: ['affiliate', 'order', 'commission', 'payout', 'settings'], required: true },
  entityId: { type: String, index: true },
  summary: { type: String, required: true },
  meta: { type: Schema.Types.Mixed },
});
export type ActivityFields = InferSchemaType<typeof activitySchema>;
export const Activity = model('Activity', activitySchema);

/** Program terms. A single document (key "program"), editable by admins. */
const settingsSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, default: 'program' },
    commissionRateBps: { type: Number, default: 1200 },
    customerDiscountPct: { type: Number, default: 10 },
    holdDays: { type: Number, default: 15 },
    minPayout: { type: Number, default: 50_000 },
    payoutWeekday: { type: Number, default: 5 },
    tdsRateBps: { type: Number, default: 200 },
    tdsNoPanRateBps: { type: Number, default: 2000 },
    highValueOrder: { type: Number, default: 1_500_000 }, // ₹15,000: flag for review
  },
  { timestamps: true },
);
export type SettingsFields = InferSchemaType<typeof settingsSchema>;
export const Settings = model('Settings', settingsSchema);

/** Share-link clicks, counted per partner per IST day (cheap to store, enough for a funnel). */
const clickDaySchema = new Schema({
  affiliateId: { type: Types.ObjectId, ref: 'Affiliate', required: true },
  day: { type: String, required: true },
  count: { type: Number, default: 0 },
});
clickDaySchema.index({ affiliateId: 1, day: 1 }, { unique: true });
export const ClickDay = model('ClickDay', clickDaySchema);

/** Lease-style lock so only one API instance runs a scheduled job at a time. */
const jobLockSchema = new Schema({ _id: String, lockedUntil: Date, holder: String });
export const JobLock = model('JobLock', jobLockSchema);
