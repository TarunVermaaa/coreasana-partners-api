/**
 * Business dates are Indian Standard Time: "payouts every Friday" means Friday in India,
 * whatever timezone the server runs in. IST has no daylight saving, so a fixed offset is exact.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

export const addDays = (d: Date, days: number) => new Date(d.getTime() + days * DAY_MS);

/** "YYYY-MM-DD" of the given instant in IST. */
export function istDay(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Start of that IST calendar day, as a UTC instant. */
export function istStartOfDay(d: Date): Date {
  return new Date(Date.parse(`${istDay(d)}T00:00:00.000Z`) - IST_OFFSET_MS);
}

/**
 * The next payout run on `weekday` (0 = Sunday … 5 = Friday), as an IST date string.
 * If today is the payout day, today's run counts as next.
 */
export function nextPayoutDate(now: Date, weekday: number): string {
  const today = new Date(Date.parse(`${istDay(now)}T00:00:00.000Z`));
  const delta = (weekday - today.getUTCDay() + 7) % 7;
  return addDays(today, delta).toISOString().slice(0, 10);
}

/** ISO-8601 week number, used in payout batch numbers (PO-2026-W43). */
export function isoWeek(dateStr: string): { year: number; week: number } {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day); // Thursday of this week decides the year
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return { year: d.getUTCFullYear(), week: Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7) };
}
