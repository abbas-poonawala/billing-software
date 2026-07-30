function normaliseString(value: string | null | undefined): string {
  if (!value) return "";
  return value.toString().trim();
}

export function normalisePhone(phone?: string | null): string | null {
  const input = normaliseString(phone);
  if (!input) return null;
  const digits = input.replace(/\D/g, "");
  if (digits.length < 10) return null;
  return `+91${digits.slice(-10)}`;
}
