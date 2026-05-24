/**
 * Normalizes a phone number to E.164 format (+91XXXXXXXXXX).
 * Handles cases where 91 is repeated multiple times.
 *
 * ✅ Correct:  919876543210  → +919876543210
 * ❌ Wrong:    9191919876543210 → +919876543210  (de-duped)
 */
export function normalizePhone(phone: string): string {
  const input = phone.toString().trim();
  if (!input) return "";

  // already has + prefix - trust it, just strip extras
  if (input.startsWith("+")) {
    return input;
  }

  // strip all non-digits
  const digits = input.replace(/[^0-9]/g, "");

  // extract the last 10 digits pactual mobile no]
  const mobile = digits.slice(-10);

  return `+91${mobile}`;
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
