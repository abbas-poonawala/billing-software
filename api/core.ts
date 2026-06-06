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
const priceCache = new Map<string, { price: number; qty: number; ts: number }>();
const shadesCache = new Map<string, { shades: string[]; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 min cache

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
  const response = await gsapi.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "Registry!B2:B",
  });
  const items = response.data.values?.flatMap((v: any) => v) || [];
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

  // try hooks sheet first
  try {
    const response = await gsapi.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${item.replace(/'/g, "''")}'!B2:B`,
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
      range: `'${item.replace(/'/g, "''")}'!B2:B`,
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
  const cacheKey = `price:${item}:${shade}`;
  const cached = priceCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.status(200).json({ price: cached.price, qty: cached.qty });
  }

  // try hooks sheet first
  try {
    const response = await gsapi.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${item.replace(/'/g, "''")}'!B2:D`,
    });
    const rows = response.data.values || [];
    if (rows.length > 0) {
      const match = findBestShadeMatch(target, rows);
      if (match) {
        const stock = match.row[1] ? Number(match.row[1]) : 0;
        const price = match.row[2] ? Number(match.row[2]) : 0;
        priceCache.set(cacheKey, { price, qty: stock, ts: Date.now() });
        return res.status(200).json({ price, qty: stock, method: match.method });
      }
    }
  } catch (err: any) {
    console.log(`Primary sheet lookup failed for item "${item}", shade "${shade}", trying LOFT`);
  }

  // fallback to loft sheet if no match found in hooks sheet
  try {
    const loftResponse = await gsapi.spreadsheets.values.get({
      spreadsheetId: LOFT_SHEET_ID,
      range: `'${item.replace(/'/g, "''")}'!B2:D`,
    });
    const rows = loftResponse.data.values || [];
    if (rows.length > 0) {
      const match = findBestShadeMatch(target, rows);
      if (match) {
        const stock = match.row[1] ? Number(match.row[1]) : 0;
        const price = match.row[2] ? Number(match.row[2]) : 0;
        priceCache.set(cacheKey, { price, qty: stock, ts: Date.now() });
        return res.status(200).json({ price, qty: stock, method: `loft-${match.method}` });
      }
    }
  } catch (err: any) {
    console.log(`LOFT sheet lookup also failed for item "${item}"`);
  }

  // no match found in either sheet, return 0
  return res.status(200).json({ price: 0, qty: 0, method: "notfound" });
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
async function handleGetPointsConfig(gsapi: any, res: VercelResponse) {
  try {
    const response = await gsapi.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "PointsConfig!A2:C2",
    });

    const row = response.data.values?.[0];

    if (!row) {
      throw new Error("PointsConfig row missing");
    }

    const earnRate = Number(row[0]) || 0.01;
    const redeemRate = Number(row[1]) || 1;
    const minRedeem = Number(row[2]) || 50;

    return res.status(200).json({
      config: {
        earnRate,
        redeemRate,
        minRedeem,
      },
    });
  } catch (err: any) {
    console.error("[GET_POINTS_CONFIG_ERROR]", err.message);
    return res.status(500).json({ error: "Failed to fetch points configuration" });
}}