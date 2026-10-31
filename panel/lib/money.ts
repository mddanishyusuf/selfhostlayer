/**
 * An amount in a currency's smallest unit (cents, as payment providers count)
 * as text: $12.50, ¥1,200, or $1.2K when compact.
 */
export function money(minor: number, currency: string, compact = false): string {
  const code = currency.toUpperCase();
  try {
    const digits = new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
    const value = minor / 10 ** digits;
    return new Intl.NumberFormat("en", { style: "currency", currency: code, ...(compact ? { notation: "compact", maximumFractionDigits: value >= 1000 ? 1 : 0 } : {}) }).format(value);
  } catch {
    return `${(minor / 100).toFixed(2)} ${code}`;
  }
}
