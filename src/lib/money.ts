/**
 * All money is stored and sent as integer paise (₹1 = 100 paise). Integers avoid floating-point drift
 * when thousands of small commissions are summed into a payout.
 * Rates are basis points (1% = 100 bps) so they stay integers too.
 */
export type Paise = number;

export const rupees = (inr: number): Paise => Math.round(inr * 100);

/** amount × rate, rounded half-up to the nearest paisa. */
export const applyBps = (amount: Paise, bps: number): Paise => Math.round((amount * bps) / 10_000);

export const bpsToPct = (bps: number) => bps / 100;
export const pctToBps = (pct: number) => Math.round(pct * 100);

export const formatInr = (amount: Paise) =>
  `₹${(amount / 100).toLocaleString('en-IN', { minimumFractionDigits: amount % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
