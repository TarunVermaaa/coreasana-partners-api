import { Schema, Types, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

export const COMMISSION_STATUSES = ['pending', 'approved', 'in_payout', 'paid', 'reversed', 'rejected'] as const;
export type CommissionStatus = (typeof COMMISSION_STATUSES)[number];

export const FLAG_CODES = ['self_referral', 'high_value', 'repeat_customer'] as const;
export type FlagCode = (typeof FLAG_CODES)[number];

/**
 * The only moves a commission can make. Every status change goes through services/commissions.ts,
 * which checks this table and makes the update conditional on the current status, so two people
 * (or a person and the release job) can never move the same commission twice.
 */
export const TRANSITIONS: Record<CommissionStatus, readonly CommissionStatus[]> = {
  pending: ['approved', 'rejected', 'reversed'],
  approved: ['in_payout', 'rejected', 'reversed'],
  in_payout: ['paid', 'approved'], // back to approved when a bank transfer fails
  paid: [],
  reversed: [],
  rejected: [],
};

const actorSchema = new Schema(
  {
    type: { type: String, enum: ['system', 'staff', 'webhook', 'affiliate'], required: true },
    id: { type: String },
    name: { type: String, required: true },
  },
  { _id: false },
);

const historySchema = new Schema(
  {
    at: { type: Date, required: true },
    from: { type: String, enum: [...COMMISSION_STATUSES, null] },
    to: { type: String, enum: COMMISSION_STATUSES, required: true },
    by: { type: actorSchema, required: true },
    note: String,
  },
  { _id: false },
);

/**
 * One row in a partner's earnings ledger. A sale creates a positive `sale` commission; a refund after
 * the money has left creates a negative `clawback` that is netted against the next payout.
 * The full status history is embedded, so "what happened to this commission?" is a single read.
 */
const commissionSchema = new Schema(
  {
    affiliateId: { type: Types.ObjectId, ref: 'Affiliate', required: true },
    orderId: { type: Types.ObjectId, ref: 'Order', required: true },
    kind: { type: String, enum: ['sale', 'clawback'], required: true },
    base: { type: Number, required: true }, // paise the rate was applied to
    rateBps: { type: Number, required: true },
    amount: { type: Number, required: true }, // paise; negative for clawbacks
    status: { type: String, enum: COMMISSION_STATUSES, required: true },
    holdUntil: { type: Date, required: true },
    placedAt: { type: Date, required: true }, // when the order was placed (refund time for clawbacks)
    flags: {
      type: [new Schema({ code: { type: String, enum: FLAG_CODES, required: true }, message: { type: String, required: true } }, { _id: false })],
      default: [],
    },
    review: {
      type: new Schema(
        { decision: { type: String, enum: ['approve', 'reject'] }, note: String, by: actorSchema, at: Date },
        { _id: false },
      ),
      default: null,
    },
    payoutId: { type: Types.ObjectId, ref: 'Payout', default: null },
    paidAt: { type: Date, default: null },
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true },
);

commissionSchema.index({ affiliateId: 1, status: 1, createdAt: -1 });
commissionSchema.index({ status: 1, holdUntil: 1 });
commissionSchema.index({ affiliateId: 1, placedAt: -1 });
// At most one sale commission per order, enforced by the database — replayed webhooks can't double-count.
commissionSchema.index({ orderId: 1 }, { unique: true, partialFilterExpression: { kind: 'sale' } });

export type CommissionFields = InferSchemaType<typeof commissionSchema>;
export type CommissionDoc = HydratedDocument<CommissionFields>;
export type Actor = { type: 'system' | 'staff' | 'webhook' | 'affiliate'; id?: string; name: string };
export const Commission = model('Commission', commissionSchema);
