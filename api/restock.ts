import { google } from "googleapis";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT!),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const STORE_SHEET_ID = process.env.SHEET_ID!;
const RESTOCK_PHONE = "9004452933";
const RESTOCK_SHEET = "Restock Requests";

type RegistryRule = { item: string; tabName: string; min: number; max: number };
type StockEntry = { item: string; tabName: string; shade: string; stock: number };
type PendingEntry = { item: string; tabName: string; shade: string; quantity: number };

function normalise(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function keyFor(tabName: string, shade: string): string {
  return `${normalise(tabName)}|${normalise(shade)}`;
}

function escapeSheetName(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

function numberOrNull(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function ensureRestockSheet(gsapi: any): Promise<void> {
  const metadata = await gsapi.spreadsheets.get({
    spreadsheetId: STORE_SHEET_ID,
    fields: "sheets.properties.title",
  });
  const exists = (metadata.data.sheets || []).some(
    (sheet: any) => sheet.properties?.title === RESTOCK_SHEET
  );
  if (exists) return;

  await gsapi.spreadsheets.batchUpdate({
    spreadsheetId: STORE_SHEET_ID,
    requestBody: {
      requests: [{ addSheet: { properties: { title: RESTOCK_SHEET } } }],
    },
  });
  await gsapi.spreadsheets.values.update({
    spreadsheetId: STORE_SHEET_ID,
    range: `${RESTOCK_SHEET}!A1:E1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [["Item", "Tab Name", "Shade", "Pending Qty", "Updated At"]] },
  });
}

async function readRegistry(gsapi: any): Promise<RegistryRule[]> {
  const response = await gsapi.spreadsheets.values.get({
    spreadsheetId: STORE_SHEET_ID,
    range: "Registry!A2:D",
  });
  return (response.data.values || []).flatMap((row: unknown[]) => {
    const item = String(row[0] ?? "").trim();
    const tabName = String(row[1] ?? "").trim();
    const min = numberOrNull(row[2]);
    const max = numberOrNull(row[3]);
    if (!item || !tabName || min === null || max === null || max < min) return [];
    return [{ item, tabName, min, max }];
  });
}

async function readInventory(gsapi: any, rules: RegistryRule[]): Promise<StockEntry[]> {
  const byKey = new Map<string, StockEntry>();
  for (const rule of rules) {
    try {
      const response = await gsapi.spreadsheets.values.get({
        spreadsheetId: STORE_SHEET_ID,
        range: `${escapeSheetName(rule.tabName)}!B2:C`,
      });
      for (const row of response.data.values || []) {
        const shade = String(row[0] ?? "").trim();
        const stock = numberOrNull(row[1]);
        if (!shade || stock === null) continue;
        const key = keyFor(rule.tabName, shade);
        const existing = byKey.get(key);
        if (existing) existing.stock += stock;
        else byKey.set(key, { item: rule.item, tabName: rule.tabName, shade, stock });
      }
    } catch (error) {
      console.warn(`Could not read inventory tab ${rule.tabName}`, error);
    }
  }
  return [...byKey.values()];
}

function looksLikeDate(value: unknown): boolean {
  return /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(String(value ?? "").trim());
}

async function readPending(
  gsapi: any,
  rules: RegistryRule[]
): Promise<Map<string, PendingEntry>> {
  const response = await gsapi.spreadsheets.values.get({
    spreadsheetId: STORE_SHEET_ID,
    range: `${RESTOCK_SHEET}!A2:E`,
  });
  const pending = new Map<string, PendingEntry>();
  for (const row of response.data.values || []) {
    const first = String(row[0] ?? "").trim();
    const second = String(row[1] ?? "").trim();
    const legacyRow = looksLikeDate(row[2]);
    const rule = rules.find(candidate => normalise(candidate.tabName) === normalise(first));
    const item = legacyRow ? rule?.item || first : first;
    const tabName = legacyRow ? first : second;
    const shade = legacyRow ? second : String(row[2] ?? "").trim();
    if (!tabName || !shade) continue;
    const quantity = legacyRow ? 1 : Math.max(1, Math.ceil(numberOrNull(row[3]) ?? 1));
    const key = keyFor(tabName, shade);
    const existing = pending.get(key);
    if (existing) existing.quantity += quantity;
    else pending.set(key, { item, tabName, shade, quantity });
  }
  return pending;
}

async function replacePending(
  gsapi: any,
  entries: PendingEntry[]
): Promise<void> {
  await gsapi.spreadsheets.values.clear({
    spreadsheetId: STORE_SHEET_ID,
    range: `${RESTOCK_SHEET}!A2:E`,
    requestBody: {},
  });
  if (entries.length === 0) return;

  await gsapi.spreadsheets.values.update({
    spreadsheetId: STORE_SHEET_ID,
    range: `${RESTOCK_SHEET}!A2:E`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: entries.map(entry => [
        entry.item,
        entry.tabName,
        entry.shade,
        entry.quantity,
        new Date().toISOString(),
      ]),
    },
  });
}

async function handleStoreRestock(res: VercelResponse): Promise<VercelResponse> {
  try {
    const client = await auth.getClient();
    const gsapi = google.sheets({ version: "v4", auth: client as any });
    await ensureRestockSheet(gsapi);

    const rules = await readRegistry(gsapi);
    const [inventory, pending] = await Promise.all([
      readInventory(gsapi, rules),
      readPending(gsapi, rules),
    ]);
    const rulesByTab = new Map(rules.map(rule => [normalise(rule.tabName), rule]));
    const consolidated = new Map<string, PendingEntry>();

    for (const entry of inventory) {
      const rule = rulesByTab.get(normalise(entry.tabName));
      if (!rule || entry.stock >= rule.min) continue;

      const required = Math.max(0, Math.ceil(rule.max - entry.stock));
      if (required <= 0) continue;
      const key = keyFor(entry.tabName, entry.shade);
      const existing = pending.get(key);
      consolidated.set(key, {
        item: entry.item,
        tabName: entry.tabName,
        shade: entry.shade,
        // Recalculate from current stock; never add the same requirement twice.
        quantity: Math.max(required, existing?.quantity || 0),
      });
    }

    const entries = [...consolidated.values()].sort((a, b) =>
      keyFor(a.tabName, a.shade).localeCompare(keyFor(b.tabName, b.shade))
    );
    await replacePending(gsapi, entries);

    if (entries.length === 0) {
      return res.status(200).json({ message: null, summary: "No restock needed." });
    }

    const message = [
      "*Restock List*",
      "",
      ...entries.map(entry => `${entry.item} ${entry.shade} — ${entry.quantity} balls`),
    ].join("\n");
    const waLink = `https://wa.me/${RESTOCK_PHONE}?text=${encodeURIComponent(message)}`;
    return res.status(200).json({ message, waLink, summary: `${entries.length} item(s) need restock.` });
  } catch (error: any) {
    console.error("Error in handleStoreRestock:", error);
    return res.status(500).json({ error: error.message || "Failed to generate restock" });
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (req.query.type !== "store") return res.status(400).json({ error: "Unknown restock type" });
  return handleStoreRestock(res);
}
