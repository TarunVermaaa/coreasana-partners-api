import { Schema, Types, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

// A snapshot of where the money was sent. If the partner changes their details later,
// the batch still shows exactly what finance paid to.
const methodSnapshotSchema = new Schema(
  {
    kind: { type: String, enum: ['upi', 'bank'], required: true },
    upiId: String,
    accountName: String,
    accountNumberEnc: String,
    accountNumberLast4: String,
    ifsc: String,
  },
  { _id: false },
);

const payoutItemSchema = new Schema({
  affiliateId: { type: Types.ObjectId, ref: 'Affiliate', required: true },
  affiliateName: { type: String, required: true },
  code: { type: String, required: true },
  method: { type: methodSnapshotSchema, required: true },
  commissionIds: [{ type: Schema.Types.ObjectId, ref: 'Commission' }],
  gross: { type: Number, required: true },
  tdsRateBps: { type: Number, required: true },
  tds: { type: Number, required: true },
  net: { type: Number, required: true },
  status: { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending' },
  utr: { type: String, default: null },
  failureReason: { type: String, default: null },
  paidAt: { type: Date, default: null },
});

/**
 * One weekly payout run. Items are embedded: the batch is the unit finance works on, and a run
 * holds at most a few thousand partners — far inside MongoDB's 16 MB document limit.
 */
const payoutSchema = new Schema(
  {
    number: { type: String, required: true, unique: true }, // PO-2026-W43
    status: { type: String, enum: ['processing', 'completed'], default: 'processing', index: true },
    scheduledFor: { type: String, required: true }, // IST date "YYYY-MM-DD"
    createdBy: { id: String, name: { type: String, required: true } },
    items: { type: [payoutItemSchema], default: [] },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
payoutSchema.index({ 'items.affiliateId': 1, createdAt: -1 });

export type PayoutFields = InferSchemaType<typeof payoutSchema>;
export type PayoutDoc = HydratedDocument<PayoutFields>;
export const Payout = model('Payout', payoutSchema);
