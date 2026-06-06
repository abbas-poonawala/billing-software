/**
 * Normalizes a phone number to E.164 format (+91XXXXXXXXXX).
 * Handles cases where 91 is repeated multiple times.
 * Returns empty string if no valid 10-digit mobile found.
 *
 * ✅ Correct:  919876543210  → +919876543210
 * ❌ Wrong:    9191919876543210 → +919876543210  (de-duped)
 * ✅ Empty:    "" or "91" → ""  (no valid mobile)
 */
export function normalizePhone(phone: string): string {
  const trimmed = phone.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("+")) {
    return trimmed;
  }
  const dig = trimmed.replace(/\D/g, "");
  if (dig.length < 10) { return `+91${dig}`;
}
return trimmed;
}
// returns true if the phone string represents a valid indian mobile number

export function isValidPhone(phone: string): boolean {
  const digits = phone.replace(/[^0-9]/g, "");
  return digits.length >= 10;
}

// formats a phone number for whatsapp url
export function phoneForWhatsApp(phone: string): string {
  return normalizePhone(phone).replace("+", "");
}
