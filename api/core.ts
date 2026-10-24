// api/core.ts
import { google } from "googleapis";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT!),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const SPREADSHEET_ID = process.env.SHEET_ID!;
const LOFT_SHEET_ID = process.env.LOFT_SHEET_ID!;

// Simple in-memory cache for expensive lookups
const priceCache = new Map<string, {
  price: number; qty: number; ts: number;
  individualCashPrice?: number; individualGPayPrice?: number;
  packetCashPrice?: number; packetGPayPrice?: number; packetSize?: number;
}>();
const shadesCache = new Map<string, { shades: string[]; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 min cache
let registryCache: { rows: any[][]; ts: number } | null = null;

async function getRegistryRows(gsapi: any): Promise<any[][]> {
  if (registryCache && Date.now() - registryCache.ts < CACHE_TTL) return registryCache.rows;
  const response = await gsapi.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "Registry!A2:C",
  });
  const rows = response.data.values || [];
  registryCache = { rows, ts: Date.now() };
  return rows;
}

async function getRegistryEntry(gsapi: any, item: string): Promise<{ item: string; sheetName: string; packetSize: number } | null> {
  const target = normalizeShade(item);
  const row = (await getRegistryRows(gsapi)).find((candidate: any[]) =>
    normalizeShade(candidate[0] || "") === target || normalizeShade(candidate[1] || "") === target
  );
  if (!row) return null;
  return {
    item: String(row[0] || item),
    sheetName: String(row[1] || row[0] || item),
    packetSize: Number(row[2]) || 0,
  };
}

function normalizeShade(shade: string): string {
  return shade.toString().trim().toLowerCase();
}

function levenshteinDistance(a: string, b: string): number {
  const aLen = a.length, bLen = b.length;
  const matrix: number[][] = [];
  for (let i = 0; i <= bLen; i++) matrix[i] = [i];
  for (let j = 0; j <= aLen; j++) matrix[0][j] = j;
  for (let i = 1; i <= bLen; i++) {
    for (let j = 1; j <= aLen; j++) {
      matrix[i][j] = a[j - 1] === b[i - 1]
        ? matrix[i - 1][j - 1]
        : Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
    }
  }
  return matrix[bLen][aLen];
}

function findBestShadeMatch(target: string, rows: any[]): any {
  // step 1: exact match
  let match = rows.find((r: any) => normalizeShade(r[0] || "") === target);
  if (match) return { row: match, method: "exact" };

  // step 2: startsWith [row starts with target]
  match = rows.find((r: any) => normalizeShade(r[0] || "").startsWith(target));
  if (match) return { row: match, method: "startsWith" };

  // step 3: reverse startsWith [target starts with row]
  match = rows.find((r: any) => target.startsWith(normalizeShade(r[0] || "")));
  if (match) return { row: match, method: "reverseStarts" };

  // step 4: fuzzy matching with levenshtein distance
  let bestMatch = null;
  let bestDistance = Math.max(3, Math.ceil(target.length * 0.3)); // allow 30% difference
  for (const row of rows) {
    const rowShade = normalizeShade(row[0] || "");
    const distance = levenshteinDistance(target, rowShade);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestMatch = row;
    }
  }
  if (bestMatch) return { row: bestMatch, method: "fuzzy" };

  return null;
}

async function getProfitPricing(
  gsapi: any,
  item: string,
  sheetName: string,
  shade: string
): Promise<{ packetCashPrice: number; packetGPayPrice: number }> {
  const response = await gsapi.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "Profit!A2:G",
  });
  const targetItem = normalizeShade(item);
  const targetSheet = normalizeShade(sheetName);
  const targetShade = normalizeShade(shade);
  const row = (response.data.values || []).find((candidate: any[]) => {
    const rowItem = normalizeShade(candidate[0] || "");
    const rowShade = normalizeShade(candidate[1] || "");
    const itemMatches = rowItem === targetItem || rowItem === targetSheet;
    const shadeMatches = rowShade === targetShade ||
      rowShade.startsWith(targetShade) ||
      targetShade.startsWith(rowShade);
    return itemMatches && shadeMatches;
  });
  return {
    packetCashPrice: Number(row?.[5]) || 0,
    packetGPayPrice: Number(row?.[6]) || 0,
  };
}

function normalizePhone(phone: string): string {
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { action } = req.query;
  
  if (!action || typeof action !== "string") {
    return res.status(400).json({ error: "Missing action parameter" });
  }

  try {
    const client = await auth.getClient();
    const gsapi = google.sheets({ version: "v4", auth: client as any });

    switch (action) {
      case "getItems":
        return await handleGetItems(gsapi, res);
      case "getShades":
        return await handleGetShades(gsapi, req, res);
      case "getPrice":
        return await handleGetPrice(gsapi, req, res);
      case "getCost":
        return await handleGetCost(gsapi, req, res);
      case "getPointsConfig":
        return res.status(200).json({ config: await getPointsConfig(gsapi) });
      case "getCustomer":
        return await handleGetCustomer(gsapi, req, res);
      case "searchCustomersByName":
        return await handleSearchCustomersByName(gsapi, req, res);
      case "searchCustomersById":
        return await handleSearchCustomersById(gsapi, req, res);
      case "searchCustomersByPhone":
        return await handleSearchCustomersByPhone(gsapi, req, res);
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to process request" });
  }
}

async function handleGetItems(gsapi: any, res: VercelResponse) {
  const rows = await getRegistryRows(gsapi);
  const items = rows.map(row => row[0] || row[1]).filter(Boolean);
  return res.status(200).json({ items });
}

async function handleGetShades(gsapi: any, req: VercelRequest, res: VercelResponse) {
  const { item } = req.query;
  if (!item || typeof item !== "string") {
    return res.status(400).json({ error: "Missing item parameter" });
  }

  const cacheKey = `shades:${item}`;
  const cached = shadesCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.status(200).json({ shades: cached.shades });
  }

  const registry = await getRegistryEntry(gsapi, item);
  const sheetName = registry?.sheetName || item;

  // try hooks sheet first
  try {
    const response = await gsapi.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${sheetName.replace(/'/g, "''")}'!B2:B`,
    });
    const shades = response.data.values?.flatMap((v: any) => v) || [];
    if (shades.length > 0) {
      shadesCache.set(cacheKey, { shades, ts: Date.now() });
      return res.status(200).json({ shades });
    }
  } catch (err: any) {
    console.log(`Hooks sheet lookup failed for item "${item}", trying LOFT`);
  }

  // fallback to loft sheet if hooks sheet doesnt exist or is empty
  try {
    const loftResponse = await gsapi.spreadsheets.values.get({
      spreadsheetId: LOFT_SHEET_ID,
      range: `'${sheetName.replace(/'/g, "''")}'!B2:B`,
    });
    const shades = loftResponse.data.values?.flatMap((v: any) => v) || [];
    shadesCache.set(cacheKey, { shades, ts: Date.now() });
    return res.status(200).json({ shades });
  } catch (err: any) {
    console.log(`LOFT sheet lookup also failed for item "${item}"`);
    return res.status(200).json({ shades: [] });
  }
}

async function handleGetPrice(gsapi: any, req: VercelRequest, res: VercelResponse) {
  const { item, shade } = req.query;
  if (!item || !shade || typeof item !== "string" || typeof shade !== "string") {
    return res.status(400).json({ error: "Missing item or shade parameter" });
  }

  const target = normalizeShade(shade);
  const registry = await getRegistryEntry(gsapi, item);
  const sheetName = registry?.sheetName || item;
  const requestedMode = req.query.paymentMode === "Cash" ? "Cash" : "GPay";
  const cacheKey = `price:${sheetName}:${shade}`;
  const cached = priceCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.status(200).json({
      ...cached,
      price: requestedMode === "Cash" ? cached.individualCashPrice : cached.individualGPayPrice,
    });
  }

  let stock = 0;
  let method = "notfound";
  try {
    const response = await gsapi.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${sheetName.replace(/'/g, "''")}'!B2:E`,
    });
    const rows = response.data.values || [];
    const match = findBestShadeMatch(target, rows);
    if (match) {
      stock = Number(match.row[1]) || 0;
      const individualCashPrice = Number(match.row[2]) || 0;
      const individualGPayPrice = Number(match.row[3]) || individualCashPrice;
      method = match.method;
      const packetPricing = await getProfitPricing(
        gsapi,
        registry?.item || item,
        sheetName,
        match.row[0] || shade
      );
      const entry = {
        price: requestedMode === "Cash" ? individualCashPrice : individualGPayPrice,
        qty: stock, ts: Date.now(), individualCashPrice, individualGPayPrice,
        ...packetPricing,
        packetSize: registry?.packetSize || 0,
        method,
      };
      priceCache.set(cacheKey, entry);
      return res.status(200).json(entry);
    }
  } catch (err: any) {
    console.log(`Primary sheet lookup failed for item "${item}", shade "${shade}", trying LOFT`);
  }

  if (method === "notfound") {
    try {
      const loftResponse = await gsapi.spreadsheets.values.get({
        spreadsheetId: LOFT_SHEET_ID,
        range: `'${sheetName.replace(/'/g, "''")}'!B2:E`,
      });
      const match = findBestShadeMatch(target, loftResponse.data.values || []);
      if (match) {
        stock = Number(match.row[1]) || 0;
        const individualCashPrice = Number(match.row[2]) || 0;
        const individualGPayPrice = Number(match.row[3]) || individualCashPrice;
        method = `loft-${match.method}`;
        const packetPricing = await getProfitPricing(
          gsapi,
          registry?.item || item,
          sheetName,
          match.row[0] || shade
        );
        const entry = {
          price: requestedMode === "Cash" ? individualCashPrice : individualGPayPrice,
          qty: stock, ts: Date.now(), individualCashPrice, individualGPayPrice,
          ...packetPricing,
          packetSize: registry?.packetSize || 0,
          method,
        };
        priceCache.set(cacheKey, entry);
        return res.status(200).json(entry);
      }
    } catch (err: any) {
      console.log(`LOFT sheet lookup also failed for item "${item}"`);
    }
  }

  return res.status(200).json({ price: 0, qty: stock, method: "notfound" });
}

async function handleGetCost(gsapi: any, req: VercelRequest, res: VercelResponse) {
  const { item, shade } = req.query;
  if (!item || typeof item !== "string") {
    return res.status(400).json({ error: "Missing item parameter" });
  }

  const normalizedItem = normalizeShade(item);
  const normalizedShade = shade && typeof shade === "string" ? normalizeShade(shade) : "";

  // try hooks sheet first
  try {
    const response = await gsapi.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "Profit!A2:C",
    });

    const rows = response.data.values || [];

    // exact match first
    let matchedRow = rows.find((r: any) => {
      const rowItem = normalizeShade(r[0] || "");
      const rowShade = normalizeShade(r[1] || "");
      return rowItem === normalizedItem && rowShade === normalizedShade;
    });
    
    // fallback to item only
    if (!matchedRow) {
      matchedRow = rows.find((r: any) => {
        const rowItem = normalizeShade(r[0] || "");
        return rowItem === normalizedItem;
      });
    }

    if (matchedRow) {
      const cost = matchedRow[2] ? Number(matchedRow[2]) : 0;
      return res.status(200).json({ cost });
    }
  } catch (err: any) {
    console.log(`Primary Profit sheet lookup failed for item "${item}"`);
  }

  // loft fallback - try to find in loft if not in hooks
  if (LOFT_SHEET_ID) {
    try {
      const loftResponse = await gsapi.spreadsheets.values.get({
        spreadsheetId: LOFT_SHEET_ID,
        range: "Profit!A2:C",
      });

      const rows = loftResponse.data.values || [];
      let matchedRow = rows.find((r: any) => {
        const rowItem = normalizeShade(r[0] || "");
        const rowShade = normalizeShade(r[1] || "");
        return rowItem === normalizedItem && rowShade === normalizedShade;
      });
      
      if (!matchedRow) {
        matchedRow = rows.find((r: any) => {
          const rowItem = normalizeShade(r[0] || "");
          return rowItem === normalizedItem;
        });
      }

      if (matchedRow) {
        const cost = matchedRow[2] ? Number(matchedRow[2]) : 0;
        return res.status(200).json({ cost });
      }
    } catch (err: any) {
      console.log(`LOFT Profit sheet lookup also failed`);
    }
  }

  return res.status(200).json({ cost: 0 });
}

async function handleGetCustomer(gsapi: any, req: VercelRequest, res: VercelResponse) {
  const { phone } = req.query;
  if (!phone || typeof phone !== "string") {
    return res.status(400).json({ error: "Missing phone parameter" });
  }

  // schema: A: Customer ID, B: Name, C: Phone1, D: Phone2, E: FirstVisit, F: LastVisit, G: Expenditure, H: TotalBills, I: Points
  const response = await gsapi.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "Customers!A2:I",
  });

  const rows = response.data.values || [];
  const phoneNormalized = normalizePhone(phone);
  const matchedRow = rows.find((r: any) => {
    const rowPhone = normalizePhone(r[2]?.toString() || "");
    return rowPhone === phoneNormalized;
  });

  if (!matchedRow) {
    return res.status(200).json({ customer: null });
  }

  return res.status(200).json({
    customer: {
      customerId: matchedRow[0] || "",
      name: matchedRow[1] || "",
      phone: matchedRow[2] || "",
      phone2: matchedRow[3] || "",
      totalSpend: Number(matchedRow[6] || 0),
      totalBills: Number(matchedRow[7] || 0),
      points: Number(matchedRow[8] || 0),
    },
  });
}

async function handleSearchCustomersByName(gsapi: any, req: VercelRequest, res: VercelResponse) {
  const { name } = req.query;
  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "Missing name parameter" });
  }

  const response = await gsapi.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "Customers!A2:I",
  });
  const rows = response.data.values || [];
  const searchName = name.toString().trim().toLowerCase();
  const matches = rows.filter((r: any) => {
    const custName = r[1]?.toString().trim().toLowerCase();
    return custName && custName.includes(searchName);
  }).map((r: any) => ({
    customerId: r[0] || "",
    name: r[1] || "",
    phone: r[2] || "",
    phone2: r[3] || "",
    points: Number(r[8]) || 0,
  })).slice(0, 20);
  return res.status(200).json({ customers: matches });
}

async function handleSearchCustomersById(gsapi: any, req: VercelRequest, res: VercelResponse) {
  const { customerId } = req.query;
  if (!customerId || typeof customerId !== "string") {
    return res.status(400).json({ error: "Missing customerId parameter" });
  }

  const response = await gsapi.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "Customers!A2:I",
  });
  const rows = response.data.values || [];
  const matched = rows.find((r: any) => r[0]?.toString().trim() === customerId.toString().trim());
  if (!matched) {
    return res.status(200).json({ customer: null });
  }
  return res.status(200).json({
    customer: {
      customerId: matched[0] || "",
      name: matched[1] || "",
      phone: matched[2] || "",
      phone2: matched[3] || "",
      totalSpend: Number(matched[6]) || 0,
      totalBills: Number(matched[7]) || 0,
      points: Number(matched[8]) || 0, 
    },
  });
}

async function handleSearchCustomersByPhone(gsapi: any, req: VercelRequest, res: VercelResponse) {
  const { phone } = req.query;
  if (!phone || typeof phone !== "string") {
    return res.status(400).json({ error: "Missing phone parameter" });
  }

  const response = await gsapi.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "Customers!A2:I",
  });

  const rows = response.data.values || [];
  const phoneNormalized = normalizePhone(phone);
  
  // FIX 3c: Correct column indexes. Schema: C=Phone1 [2], D=Phone2 [3]
  // BUG WAS: Reading from [3] and [4], should be [2] and [3]
  const matched = rows.find((r: any) => {
    const rowPhone1 = normalizePhone(r[2]?.toString() || ""); // Phone1 in column C (index 2)
    const rowPhone2 = r[3] ? normalizePhone(r[3]?.toString()) : null; // Phone2 in column D (index 3), only if non-empty
    return rowPhone1 === phoneNormalized || (rowPhone2 && rowPhone2 === phoneNormalized);
  });

  if (!matched) {
    return res.status(200).json({ customer: null });
  }

  return res.status(200).json({
    customer: {
      customerId: matched[0] || "",
      name: matched[1] || "",
      phone: matched[2] || "",
      phone2: matched[3] || "",
      totalSpend: Number(matched[6]) || 0,
      totalBills: Number(matched[7]) || 0,
      points: Number(matched[8]) || 0, // FIX 3b: Column I (index 8) - Points column
    },
  });
}

// points configuration
async function getPointsConfig(gsapi: any) {
  const response = await gsapi.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "PointsConfig!A:B",
  });

  const rows = response.data.values || [];

  const map = Object.fromEntries(rows);

  return {
    earnRate: Number(map.EarnRate ?? 0.005),
    redeemRate: Number(map.RedeemRate ?? 0.5),
    minRedeem: Number(map.MinRedeem ?? 50),

    spendBonus: parseTierMap(map.SpendBonus ?? ""),
    billBonus: parseTierMap(map.BillBonus ?? ""),
  };
}

function parseTierMap(value: string) {
  return value
    .split(",")
    .map(v => v.trim())
    .filter(Boolean)
    .map(entry => {
      const [threshold, bonus] = entry.split(":");

      return {
        threshold: Number(threshold),
        bonus: Number(bonus),
      };
    });
}