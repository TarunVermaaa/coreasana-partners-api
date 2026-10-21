import { Schema, Types, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const itemSchema = new Schema(
  {
    sku: String,
    name: { type: String, required: true },
    qty: { type: Number, required: true, min: 1 },
    price: { type: Number, required: true, min: 0 }, // paise, per unit
  },
  { _id: false },
);

/**
 * An order placed on the store with a partner's code. Only the fields needed for attribution
 * and commission are kept; the shopper is stored as fingerprints, not contact details.
 */
const orderSchema = new Schema(
  {
    externalId: { type: String, required: true, unique: true }, // the store's order id: idempotency key
    affiliateId: { type: Types.ObjectId, ref: 'Affiliate', required: true, index: true },
    code: { type: String, required: true, uppercase: true },
    placedAt: { type: Date, required: true, index: true },
    customer: {
      emailFp: String,
      phoneFp: String,
    },
    items: { type: [itemSchema], default: [] },
    subtotal: { type: Number, required: true, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    shipping: { type: Number, default: 0, min: 0 },
    tax: { type: Number, default: 0, min: 0 },
    total: { type: Number, required: true, min: 0 },
    status: { type: String, enum: ['placed', 'refunded', 'partially_refunded'], default: 'placed' },
    refundedAmount: { type: Number, default: 0, min: 0 },
    source: { type: String, enum: ['webhook', 'demo'], default: 'webhook' },
  },
  { timestamps: true },
);

export type OrderFields = InferSchemaType<typeof orderSchema>;
export type OrderDoc = HydratedDocument<OrderFields>;
export const Order = model('Order', orderSchema);
