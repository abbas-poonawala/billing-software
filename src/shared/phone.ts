export function normalizePhone(phone: string): string {
  const trimmed = phone?.toString().trim() || "";
  if (!trimmed) return "";
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 10) return "";
  return `+91${digits.slice(-10)}`;
}

export function isValidPhone(phone: string): boolean {
  return normalizePhone(phone).length > 0;
}

export function phoneForWhatsApp(phone: string): string {
  return normalizePhone(phone).replace("+", "");
}
