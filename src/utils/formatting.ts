/**
 * Formats a price number for display.
 * - Integers shown without decimal: 110 → "110"
 * - Decimals trimmed of trailing zeros: 110.50 → "110.5"
 */
export function formatPrice(price: number): string {
  const num = Number(price) || 0;
  if (Number.isInteger(num)) return num.toString();
  return num.toFixed(2).replace(/\.?0+$/, "");
}

/**
 * Parses a user-typed price string into a number.
 * Returns NaN if invalid.
 */
export function parsePrice(value: string): number {
  return parseFloat(value.trim());
}

/**
 * Returns the IST date/time strings for display.
 */
export function getISTNow(): { date: string; time: string } {
  const opts = { timeZone: "Asia/Kolkata" } as const;
  return {
    date: new Date().toLocaleDateString("en-IN", opts),
    time: new Date().toLocaleTimeString("en-IN", { ...opts, hour: "2-digit", minute: "2-digit", hour12: true }),
  };
}
