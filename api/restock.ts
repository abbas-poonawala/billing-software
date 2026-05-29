// api/restock.ts
import { google } from "googleapis";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT!),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const STORE_SHEET_ID = process.env.SHEET_ID!;
const LOFT_SHEET_ID = process.env.LOFT_SHEET_ID!;
const RESTOCK_PHONE = "9004452933";

const LOW_STOCK_THRESHOLD = 2;
const TARGET_STOCK = 5;

function getTodayIST(): string {
  return new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
}

function escapeSheetName(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

async function getPacketSize(gsapi: any, article: string): Promise<number> {
  try {
    const res = await gsapi.spreadsheets.values.get({
      spreadsheetId: LOFT_SHEET_ID,
      range: "Settings!A2:B",
    });
    const rows = res.data.values || [];
    const art = String(article).toLowerCase();
    for (const r of rows) {
      const keyword = String(r[0] || "").toLowerCase();
      if (keyword && art.includes(keyword)) return Number(r[1]) || 5;
    }
  } catch {}
  return 5;
}

function parseDate(dateStr: string): Date | null {
  if (!dateStr) return null;
  const parts = dateStr.toString().split('/');
  if (parts.length === 3) {
    const day = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    const year = parseInt(parts[2], 10);
    if (!isNaN(day) && !isNaN(month) && !isNaN(year)) {
      return new Date(year, month, day);
    }
  }
  return new Date(dateStr);
}

async function ensureRestockRequestsSheet(gsapi: any) {
  const sheetMeta = await gsapi.spreadsheets.get({
    spreadsheetId: STORE_SHEET_ID,
    fields: "sheets.properties.title",
  });
  const exists = sheetMeta.data.sheets?.some((s: any) => s.properties?.title === "Restock Requests");
  if (!exists) {
    await gsapi.spreadsheets.batchUpdate({
      spreadsheetId: STORE_SHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: "Restock Requests" } } }],
      },
    });
    await gsapi.spreadsheets.values.update({
      spreadsheetId: STORE_SHEET_ID,
      range: "Restock Requests!A1:D1",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [["Item", "Shade", "Requested Date", "Status"]] },
    });
  }
}

async function loadAlternateShades(gsapi: any): Promise<Map<string, Map<string, string>>> {
  // returns Map<item, Map<originalShade, alternateShade>>
  const altMap = new Map<string, Map<string, string>>();
  try {
    const res = await gsapi.spreadsheets.values.get({
      spreadsheetId: STORE_SHEET_ID,
      range: "Alternate Shades!A2:C",
    });
    const rows = res.data.values || [];
    for (const row of rows) {
      const item = row[0]?.toString().trim();
      const original = row[1]?.toString().trim();
      const alternate = row[2]?.toString().trim();
      if (item && original && alternate) {
        if (!altMap.has(item)) altMap.set(item, new Map());
        altMap.get(item)!.set(original, alternate);
      }
    }
  } catch (err) {
    console.warn("Could not read Alternate Shades sheet", err);
  }
  return altMap;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { type } = req.query;
  if (!type || typeof type !== "string") {
    return res.status(400).json({ error: "Missing type parameter" });
  }

  switch (type) {
    case "store":
      return await handleStoreRestock(req, res);
    case "hooks":
      return await handleHooksRestock(req, res);
    default:
      return res.status(400).json({ error: `Unknown type: ${type}` });
  }
}

async function handleStoreRestock(req: VercelRequest, res: VercelResponse) {
  const { item } = req.query;
  const isAll = item === "all";

  if (!item || typeof item !== "string") {
    return res.status(400).json({ error: "Missing item parameter. Use 'all' for full list or specify an item name." });
  }

  try {
    const client = await auth.getClient();
    const gsapi = google.sheets({ version: "v4", auth: client as any });
    const today = getTodayIST();
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    await ensureRestockRequestsSheet(gsapi);

    const altMap = await loadAlternateShades(gsapi);

    const reqRes = await gsapi.spreadsheets.values.get({
      spreadsheetId: STORE_SHEET_ID,
      range: "Restock Requests!A2:D",
    });
    const requestedRows = reqRes.data.values || [];
    const recentRequests = new Set<string>();
    for (const r of requestedRows) {
      const reqDate = parseDate(r[2]);
      if (reqDate && reqDate >= oneWeekAgo) {
        recentRequests.add(`${r[0]}|${r[1]}`);
      }
    }

    const sheetMeta = await gsapi.spreadsheets.get({
      spreadsheetId: STORE_SHEET_ID,
      fields: "sheets.properties.title",
    });
    const allSheets = (sheetMeta.data.sheets || []).map(s => s.properties?.title || "");

    const skipTabs = ["bill", "registry", "profit", "discount", "discounts", "customers", "pointslog", "pointsconfig", "restock requests", "loft fallback log", "dashboard", "alternate shades", "settings"];

    const itemSheets: string[] = [];
    for (const sheetName of allSheets) {
      if (skipTabs.includes(sheetName.toLowerCase())) continue;
      try {
        // try to read first row to check for headers
        const headers = await gsapi.spreadsheets.values.get({
          spreadsheetId: STORE_SHEET_ID,
          range: `${escapeSheetName(sheetName)}!1:1`,
        });
        const headerRow = headers.data.values?.[0] || [];
        
        // check if sheet has "Shade" header in any column
        const hasShade = headerRow.some(h => h?.toString().trim().toLowerCase() === "shade");
        
        if (hasShade) {
          itemSheets.push(sheetName);
        } else {
          // fallback: if first row looks like data [not headers], assume it's a valid item sheet
          // check if B2:C has any data to determine if sheet structure is valid
          try {
            const dataCheck = await gsapi.spreadsheets.values.get({
              spreadsheetId: STORE_SHEET_ID,
              range: `${escapeSheetName(sheetName)}!B2:C2`,
            });
            const firstDataRow = dataCheck.data.values?.[0] || [];
            if (firstDataRow.length > 0 || headerRow.length > 0) {
              // sheet has structure, assume its a valid item sheet even without "Shade" header
              itemSheets.push(sheetName);
            }
          } catch (innerErr) {
            // cant read data, skip sheet
          }
        }
      } catch (err) {
        console.warn(`Could not analyze sheet ${sheetName}:`, err);
      }
    }

    let itemsToProcess: string[] = [];
    if (isAll) {
      itemsToProcess = itemSheets;
    } else {
      const matchedItem = itemSheets.find(tab => tab.toLowerCase() === item.toLowerCase());
      if (!matchedItem) {
        const availableItems = itemSheets.join(", ") || "none found";
        return res.status(404).json({ 
          error: `Item sheet '${item}' not found. Available items: ${availableItems}`,
          availableItems: itemSheets
        });
      }
      itemsToProcess = [matchedItem];
    }

    const restockLines: string[] = [];
    const newRequests: any[] = [];
    let totalShades = 0;

    for (const tab of itemsToProcess) {
      try {
        const stockRes = await gsapi.spreadsheets.values.get({
          spreadsheetId: STORE_SHEET_ID,
          range: `${escapeSheetName(tab)}!B2:C`,
        });
        const rows = stockRes.data.values || [];

        const lowShades: { original: string, stock: number }[] = [];
        for (const r of rows) {
          const shade = r[0]?.toString().trim();
          const stockCell = r[1];
          if (!shade) continue;
          if (stockCell === undefined || stockCell === null || stockCell === "") continue;
          const stock = Number(stockCell);
          if (isNaN(stock)) continue;
          if (stock >= LOW_STOCK_THRESHOLD) continue;

          const key = `${tab}|${shade}`;
          if (recentRequests.has(key)) continue;

          lowShades.push({ original: shade, stock });
        }

        // apply alternate mapping
        const shadesToRequest: { shade: string, stock: number }[] = [];
        const alternatesForItem = altMap.get(tab) || new Map();
        // keep track of which alternates we already used to avoid duplicates
        const usedAlternateForOriginal = new Map<string, string>();

        for (const { original, stock } of lowShades) {
          let finalShade = original;
          if (alternatesForItem.has(original)) {
            finalShade = alternatesForItem.get(original)!;
            // if this alternate shade is already used for another original, we'll allow but warn
            if (usedAlternateForOriginal.has(finalShade)) {
              console.log(`Alternate ${finalShade} already used for ${usedAlternateForOriginal.get(finalShade)}, skipping ${original}`);
              continue;
            }
            usedAlternateForOriginal.set(finalShade, original);
          }
          shadesToRequest.push({ shade: finalShade, stock });
        }

        let tabLines: string[] = [];
        for (const { shade, stock } of shadesToRequest) {
          tabLines.push(`  ${shade} → stock: ${stock}`);
          newRequests.push([tab, shade, today, "Pending"]);
          totalShades++;
        }

        if (tabLines.length) {
          restockLines.push(`*${tab.toUpperCase()}*`);
          restockLines.push(...tabLines);
          restockLines.push("");
        }
      } catch (err) {
        console.error(`Error reading sheet ${tab}:`, err);
      }
    }

    if (totalShades === 0) {
      let summary = isAll
        ? "No items below threshold or all already requested this week."
        : `No restock needed for ${item} (all shades above threshold or already requested).`;
      return res.status(200).json({ message: null, summary });
    }

    if (newRequests.length > 0) {
      await gsapi.spreadsheets.values.append({
        spreadsheetId: STORE_SHEET_ID,
        range: "Restock Requests!A:D",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: newRequests },
      });
    }

    const header = isAll
      ? `*FULL HOOKS RESTOCK: ${today}*\n⚠️ Items below ${LOW_STOCK_THRESHOLD} (not yet requested this week):\n\n`
      : `*HOOKS RESTOCK: ${today}*\nItem: *${itemsToProcess[0].toUpperCase()}*\n⚠️ Shades below ${LOW_STOCK_THRESHOLD} (not yet requested this week):\n\n`;
    const footer = `\nTotal shades to restock: ${totalShades}`;
    const message = header + restockLines.join("\n") + footer;
    const waLink = `https://wa.me/${RESTOCK_PHONE}?text=${encodeURIComponent(message)}`;

    if (newRequests.length > 0) {
      const lastRow = await gsapi.spreadsheets.values.get({
        spreadsheetId: STORE_SHEET_ID,
        range: "Restock Requests!A:A",
      });
      const totalRows = (lastRow.data.values?.length || 0);
      const startRow = totalRows - newRequests.length + 1;
      for (let i = 0; i < newRequests.length; i++) {
        await gsapi.spreadsheets.values.update({
          spreadsheetId: STORE_SHEET_ID,
          range: `Restock Requests!D${startRow + i}`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [["Notified"]] },
        });
      }
    }

    return res.status(200).json({ message, waLink, summary: `${totalShades} shade(s) need restock${isAll ? " across all items" : ` for ${itemsToProcess[0]}`}` });
  } catch (err: any) {
    console.error("Error in handleStoreRestock:", err);
    return res.status(500).json({ error: err.message || "Failed to generate restock" });
  }
}

async function handleHooksRestock(req: VercelRequest, res: VercelResponse) {
  const { item } = req.query;
  if (!item || typeof item !== "string") {
    return res.status(400).json({ error: "Missing item parameter" });
  }

  try {
    const client = await auth.getClient();
    const gsapi = google.sheets({ version: "v4", auth: client as any });

    const packetSize = await getPacketSize(gsapi, item);

    const storeRes = await gsapi.spreadsheets.values.get({
      spreadsheetId: STORE_SHEET_ID,
      range: `${escapeSheetName(item)}!B2:H`,
    });
    const storeRows = storeRes.data.values || [];

    const transfers: any[] = [];
    const shortages: any[] = [];

    for (const row of storeRows) {
      const shade = row[0]?.toString().trim();
      if (!shade) continue;

      const hooksStock = Number(row[1]) || 0;
      const loftIndiv = Number(row[4]) || 0;
      const loftPackets = Number(row[5]) || 0;
      const bhiwandi = Number(row[6]) || 0;

      const needed = TARGET_STOCK - hooksStock;
      if (needed <= 0) continue;

      let remaining = needed;
      let plan: any = { shade, hooksStock, target: TARGET_STOCK, transfers: [] };

      if (bhiwandi > 0) {
        const fromBhiwandi = Math.min(remaining, bhiwandi);
        if (fromBhiwandi > 0) {
          plan.transfers.push({ from: "Bhiwandi", qty: fromBhiwandi });
          remaining -= fromBhiwandi;
        }
      }

      if (remaining > 0) {
        const loftTotal = loftIndiv + (loftPackets * packetSize);
        if (loftTotal > 0) {
          const fromLoft = Math.min(remaining, loftTotal);
          let useIndiv = Math.min(fromLoft, loftIndiv);
          let remainingFromLoft = fromLoft - useIndiv;
          let usePackets = 0;
          let leftoverIndiv = 0;
          if (remainingFromLoft > 0) {
            usePackets = Math.ceil(remainingFromLoft / packetSize);
            const ballsFromPackets = usePackets * packetSize;
            leftoverIndiv = ballsFromPackets - remainingFromLoft;
          }
          plan.transfers.push({
            from: "Loft",
            qty: fromLoft,
            breakdown: { individuals: useIndiv, packets: usePackets, leftover: leftoverIndiv },
          });
          remaining -= fromLoft;
        }
      }

      if (remaining > 0) {
        shortages.push({ shade, needed: Math.ceil(remaining / packetSize) });
      }

      if (plan.transfers.length > 0) {
        transfers.push(plan);
      }
    }

    if (transfers.length === 0 && shortages.length === 0) {
      return res.status(200).json({ message: "All shades already at target stock (5 units)", transfers: [], shortages: [] });
    }

    const lines: string[] = [`*HOOKS RESTOCK PLAN: ${item}*\nTarget per shade: ${TARGET_STOCK} units\n`];
    for (const t of transfers) {
      lines.push(`*${t.shade}*`);
      lines.push(`  Current: ${t.hooksStock} | Target: ${t.target}`);
      for (const tr of t.transfers) {
        if (tr.from === "Bhiwandi") {
          lines.push(`  Transfer ${tr.qty} from Bhiwandi`);
        } else {
          const b = tr.breakdown;
          const desc = b.packets > 0 ? `${b.individuals} indiv + ${b.packets} pkt (leftover: ${b.leftover})` : `${b.individuals} indiv`;
          lines.push(`  Transfer ${tr.qty} from Loft (${desc})`);
        }
      }
      lines.push("");
    }
    if (shortages.length > 0) {
      lines.push("*⚠️ Still Short (request from Bhiwandi):*");
      for (const s of shortages) {
        lines.push(`  ${s.shade}: needed: ${s.needed} packets (${s.needed * packetSize} units)`);
      }
    }
    const message = lines.join("\n");
    return res.status(200).json({ message, transfers, shortages, item, packetSize });
  } catch (err: any) {
    console.error("Error in handleHooksRestock:", err);
    return res.status(500).json({ error: err.message || "Failed to generate restock plan" });
  }
}