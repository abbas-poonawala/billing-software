// api/bill.ts
import { google } from "googleapis";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT!),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const STORE_SHEET_ID = process.env.SHEET_ID!;
const LOFT_SHEET_ID = process.env.LOFT_SHEET_ID!;

function getISTDateTime() {
  const now = new Date();
  const date = now.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
  const time = now.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });
  return { date, time };
}

function generateCustomerId(rows: any[][]): string {
  const ids = rows
    .map(r => r[0]?.toString())
    .filter(id => id?.startsWith("LMS-"))
    .map(id => Number(id.replace("LMS-", "")))
    .filter(n => !isNaN(n));
  const next = ids.length > 0 ? Math.max(...ids) + 1 : 1;
  return `LMS-${String(next).padStart(4, "0")}`;
}

function normalizePhone(phone: string): string {
  const input = phone.toString().trim();
  if (input.startsWith("+")) return input; // keep international format
  const digits = input.replace(/[^0-9]/g, "");
  return "+91" + digits.slice(-10); // no country code = add +91 to last 10 digits
}

function escapeSheetName(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

function getStockDeductionMultiplier(): number {
  return 1; // all items deduct qty as-is (no mode-based multiplier)
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

async function ensureBillSheetColumns(gsapi: any) {
  const sheetMeta = await gsapi.spreadsheets.get({
    spreadsheetId: STORE_SHEET_ID,
    fields: "sheets.properties(title,gridProperties,sheetId)",
  });
  const billSheet = (sheetMeta.data.sheets || []).find((s: any) => s.properties?.title === "Bill");
  if (!billSheet) return;
  const currentCols = billSheet.properties?.gridProperties?.columnCount || 0;
  if (currentCols < 15) {
    await gsapi.spreadsheets.batchUpdate({
      spreadsheetId: STORE_SHEET_ID,
      requestBody: {
        requests: [{
          updateSheetProperties: {
            properties: {
              sheetId: billSheet.properties?.sheetId,
              gridProperties: { columnCount: 15 }
            },
            fields: "gridProperties.columnCount"
          }
        }]
      }
    });
    const headerRow = await gsapi.spreadsheets.values.get({
      spreadsheetId: STORE_SHEET_ID,
      range: "Bill!1:1",
    });
    const headers = headerRow.data.values?.[0] || [];
    const updates = [];
    if (headers.length < 11 && !headers[10]) {
      updates.push(["Bill!K1", [["Gpay Charges"]]]);
    }
    if (headers.length < 12 && !headers[11]) {
      updates.push(["Bill!L1", [["Final Total"]]]);
    }
    if (headers.length < 13 && !headers[12]) {
      updates.push(["Bill!M1", [["Customer ID"]]]);
    }
    if (headers.length < 14 && !headers[13]) {
      updates.push(["Bill!N1", [["Last Updated"]]]);
    }
    if (headers.length < 15 && !headers[14]) {
      updates.push(["Bill!O1", [["Payment Mode"]]]);
    }
    for (const [range, values] of updates) {
      await gsapi.spreadsheets.values.update({
        spreadsheetId: STORE_SHEET_ID,
        range: range,
        valueInputOption: "USER_ENTERED",
        requestBody: { values }
      });
    }
  }
}


async function logLoftFallback(
  gsapi: any,
  billNo: number,
  item: string,
  shade: string,
  qtyFromLoft: number,
  individualsUsed: number,
  packetsOpened: number,
  leftoverBalls: number,
  packetSize: number,
  timestamp: string
) {
  try {
    console.log(`[LOG_FALLBACK_START] Bill: ${billNo}, Item: ${item}, Shade: ${shade}, Total: ${qtyFromLoft}, Indiv: ${individualsUsed}, Pkts: ${packetsOpened}`);

    const sheetMeta = await gsapi.spreadsheets.get({
      spreadsheetId: STORE_SHEET_ID,
      fields: "sheets.properties.title",
    });
    const sheetExists = (sheetMeta.data.sheets || []).some((s: any) => s.properties?.title === "Loft Fallback Log");
    
    if (!sheetExists) {
      console.log(`[LOG_FALLBACK_CREATE] Creating Loft Fallback Log sheet`);
      await gsapi.spreadsheets.batchUpdate({
        spreadsheetId: STORE_SHEET_ID,
        requestBody: {
          requests: [{ addSheet: { properties: { title: "Loft Fallback Log" } } }]
        }
      });
      await gsapi.spreadsheets.values.update({
        spreadsheetId: STORE_SHEET_ID,
        range: "Loft Fallback Log!A1:I1",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [["Timestamp", "Bill No", "Item", "Shade", "Total From Loft", "Individual Balls Used", "Packets Opened", "Leftover Balls", "Packet Size"]] }
      });
    }

    const logRow = [timestamp, billNo, item, shade, qtyFromLoft, individualsUsed, packetsOpened, leftoverBalls, packetSize];
    console.log(`[LOG_FALLBACK_APPEND] Row: ${JSON.stringify(logRow)}`);

    await gsapi.spreadsheets.values.append({
      spreadsheetId: STORE_SHEET_ID,
      range: "Loft Fallback Log!A:I",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [logRow],
      },
    });

    console.log(`[LOG_FALLBACK_SUCCESS] Bill: ${billNo}, Item: ${item}`);
  } catch (err) {
    console.error(`[LOG_FALLBACK_ERROR] Bill: ${billNo}, Item: ${item}, Error: ${(err as any).message}`);
  }
}

async function restoreStoreStock(gsapi: any, item: string, rowNumber: number, stock: number) {
  await gsapi.spreadsheets.values.update({
    spreadsheetId: STORE_SHEET_ID,
    range: `${escapeSheetName(item)}!C${rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[stock]] },
  });
}

async function restoreLoftStock(gsapi: any, item: string, rowNumber: number, individuals: number, packets: number) {
  await gsapi.spreadsheets.values.update({
    spreadsheetId: LOFT_SHEET_ID,
    range: `${escapeSheetName(item)}!E${rowNumber}:F${rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[individuals, packets]] },
  });
}

// Get Loft fallback log entries for a bill (to properly restore on edit)
async function getLoftFallbackLogForBill(gsapi: any, billNo: number): Promise<Array<any>> {
  try {
    const logRes = await gsapi.spreadsheets.values.get({
      spreadsheetId: STORE_SHEET_ID,
      range: "Loft Fallback Log!A2:I",
    });
    const logRows = logRes.data.values || [];
    // Find entries for this bill number (column B = Bill No)
    return logRows.filter((row: any) => Number(row[1]) === billNo);
  } catch (err) {
    console.error(`[EDIT_LOG_QUERY_ERROR] Failed to query Loft Fallback Log: ${(err as any).message}`);
    return [];
  }
}

interface StockValidationResult {
  item: string;
  shade: string;
  qty: number;
  storeRowIndex: number;
  storeStock: number;
  loftRowIndex: number;
  loftIndividuals: number;
  loftPackets: number;
  packetSize: number;
  isValid: boolean;
  errorMessage?: string;
}

async function validateAllItemsStock(
  gsapi: any,
  items: any[]
): Promise<StockValidationResult[]> {
  const validations: StockValidationResult[] = [];

  for (let idx = 0; idx < items.length; idx++) {
    const entry = items[idx];
    if (entry.misc) {
      validations.push({
        item: entry.item,
        shade: entry.shade,
        qty: entry.qty,
        storeRowIndex: -1,
        storeStock: 0,
        loftRowIndex: -1,
        loftIndividuals: 0,
        loftPackets: 0,
        packetSize: 0,
        isValid: true,
      });
      continue;
    }

    const { item, shade, qty } = entry;
    let storeRowIndex = -1;
    let storeStock = 0;
    let loftRowIndex = -1;
    let loftIndividuals = 0;
    let loftPackets = 0;
    let packetSize = 5;

    try {
      const storeRes = await gsapi.spreadsheets.values.get({
        spreadsheetId: STORE_SHEET_ID,
        range: `${escapeSheetName(item)}!B2:C`,
      });
      const storeRows = storeRes.data.values || [];
      storeRowIndex = storeRows.findIndex(
        (row: any) => row[0]?.toString().trim().toLowerCase() === shade?.toString().trim().toLowerCase()
      );
      if (storeRowIndex !== -1) {
        storeStock = Number(storeRows[storeRowIndex][1]) || 0;
      }

      try {
        const loftRes = await gsapi.spreadsheets.values.get({
          spreadsheetId: LOFT_SHEET_ID,
          range: `${escapeSheetName(item)}!A2:L`,
        });
        const loftRows = loftRes.data.values || [];
        if (!loftRows.length) {
          // No rows in Loft sheet - item doesn't exist there
          loftRowIndex = -1;
        } else {
          loftRowIndex = loftRows.findIndex(
            (row: any) => row[0]?.toString().trim().toLowerCase() === shade?.toString().trim().toLowerCase()
          );
          if (loftRowIndex !== -1) {
            loftIndividuals = Number(loftRows[loftRowIndex][4]) || 0;
            loftPackets = Number(loftRows[loftRowIndex][5]) || 0;
            packetSize = await getPacketSize(gsapi, item);
          }
        }
      } catch (loftErr: any) {
        // Loft sheet lookup failed - log error but don't fail validation
        console.error(`[LOFT_LOOKUP_ERROR] Item: ${item}, Error: ${loftErr.message}`);
        loftRowIndex = -1;
      }

      const storeAvailable = storeRowIndex !== -1 ? storeStock : 0;
      const loftAvailable = loftRowIndex !== -1 ? loftIndividuals + loftPackets * packetSize : 0;
      const totalAvailable = storeAvailable + loftAvailable;

      if (totalAvailable < qty) {
        validations.push({
          item,
          shade,
          qty,
          storeRowIndex,
          storeStock,
          loftRowIndex,
          loftIndividuals,
          loftPackets,
          packetSize,
          isValid: false,
          errorMessage: `insufficient stock for ${item} ${shade}. need ${qty}, have ${totalAvailable}`,
        });
      } else {
        validations.push({
          item,
          shade,
          qty,
          storeRowIndex,
          storeStock,
          loftRowIndex,
          loftIndividuals,
          loftPackets,
          packetSize,
          isValid: true,
        });
      }
    } catch (err: any) {
      validations.push({
        item,
        shade,
        qty,
        storeRowIndex: -1,
        storeStock: 0,
        loftRowIndex: -1,
        loftIndividuals: 0,
        loftPackets: 0,
        packetSize: 0,
        isValid: false,
        errorMessage: `error checking stock for ${item}: ${err.message}`,
      });
    }
  }

  return validations;
}

interface StockDeductionOp {
  item: string;
  shade: string;
  storeRowIndex: number;
  storeStock: number;
  loftRowIndex: number;
  loftIndividuals: number;
  loftPackets: number;
  packetSize: number;
  qty: number;
  timestamp: string;
}

async function deductAllItemsStock(
  gsapi: any,
  operations: StockDeductionOp[]
): Promise<Map<string, any>> {
  const applied = new Map<string, any>();

  for (const op of operations) {
    const { item, shade, storeRowIndex, storeStock, loftRowIndex, loftIndividuals, loftPackets, packetSize, qty, timestamp } = op;
    const multiplier = getStockDeductionMultiplier();
    const deductionQty = qty * multiplier;

    console.log(`[DEDUCT_START] Item: ${item}, Shade: ${shade}, Qty: ${deductionQty}, StoreIdx: ${storeRowIndex}, StoreQty: ${storeStock}, LoftIdx: ${loftRowIndex}, LoftIndiv: ${loftIndividuals}, LoftPkts: ${loftPackets}`);

    try {
      let remaining = deductionQty;
      let usedStore = 0;
      let usedLoftIndividuals = 0;
      let packetsOpened = 0;
      let leftoverBalls = 0;

      // STEP 1: Deduct from Store
      if (storeRowIndex !== -1 && storeStock > 0) {
        usedStore = Math.min(remaining, storeStock);
        const newStore = Math.max(0, storeStock - usedStore);  // Ensure no negative stock
        remaining -= usedStore;

        const storeCell = `${escapeSheetName(item)}!C${storeRowIndex + 2}`;
        console.log(`[DEDUCT_STORE] Item: ${item}, Row: ${storeRowIndex + 2}, Old: ${storeStock}, New: ${newStore}, Cell: ${storeCell}`);

        await gsapi.spreadsheets.values.update({
          spreadsheetId: STORE_SHEET_ID,
          range: storeCell,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[newStore]] },
        });
        await gsapi.spreadsheets.values.update({
          spreadsheetId: STORE_SHEET_ID,
          range: `${escapeSheetName(item)}!E${storeRowIndex + 2}`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[timestamp]] },
        });

        applied.set(`${item}|${shade}|store`, {
          item, shade, storeRowIndex, oldStore: storeStock, newStore,
        });
      }

      // STEP 2: Fallback to Loft (if needed)
      if (remaining > 0 && loftRowIndex !== -1) {
        console.log(`[FALLBACK_START] Item: ${item}, Shade: ${shade}, RemainingNeeded: ${remaining}, LoftIndiv: ${loftIndividuals}, LoftPkts: ${loftPackets}, PktSize: ${packetSize}`);

        // STEP 2a: Use individual balls FIRST
        usedLoftIndividuals = Math.min(remaining, loftIndividuals);
        let newIndiv = Math.max(0, loftIndividuals - usedLoftIndividuals);  // Ensure no negative
        let newPackets = loftPackets;
        remaining -= usedLoftIndividuals;

        console.log(`[FALLBACK_INDIV] Item: ${item}, Used: ${usedLoftIndividuals}, Remaining After Indiv: ${remaining}, NewIndiv: ${newIndiv}`);

        // STEP 2b: Open packets ONLY if individual balls insufficient
        if (remaining > 0 && loftPackets > 0 && packetSize > 0) {
          const needPackets = Math.ceil(remaining / packetSize);
          packetsOpened = Math.min(needPackets, loftPackets);
          const ballsFromPackets = packetsOpened * packetSize;
          newPackets = Math.max(0, loftPackets - packetsOpened);  // Ensure no negative
          
          // CRITICAL: Calculate leftover correctly
          // If we open 2 packets of size 6 = 12 balls, but only need 8, leftover = 4
          const usedFromPackets = Math.min(remaining, ballsFromPackets);
          leftoverBalls = ballsFromPackets - usedFromPackets;
          newIndiv = leftoverBalls;
          remaining -= usedFromPackets;

          console.log(`[FALLBACK_PACKETS] Item: ${item}, PktsOpened: ${packetsOpened}, BallsFromPkts: ${ballsFromPackets}, UsedFromPkts: ${usedFromPackets}, Leftover: ${leftoverBalls}, NewPkts: ${newPackets}`);
        }

        if (remaining > 0) {
          console.error(`[FALLBACK_ERROR] Item: ${item} STILL HAS REMAINING: ${remaining}! Data inconsistency!`);
        }

        // Update Loft stock
        const loftRange = `${escapeSheetName(item)}!E${loftRowIndex + 2}:F${loftRowIndex + 2}`;
        console.log(`[DEDUCT_LOFT] Item: ${item}, Row: ${loftRowIndex + 2}, OldIndiv: ${loftIndividuals}, NewIndiv: ${newIndiv}, OldPkts: ${loftPackets}, NewPkts: ${newPackets}, Range: ${loftRange}`);

        await gsapi.spreadsheets.values.update({
          spreadsheetId: LOFT_SHEET_ID,
          range: loftRange,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[newIndiv, newPackets]] },
        });

        applied.set(`${item}|${shade}|loft`, {
          item, shade, loftRowIndex, oldIndiv: loftIndividuals, oldPackets: loftPackets, newIndiv, newPackets,
        });
      }

      // STEP 3: Log Loft fallback with detailed source breakdown
      const totalFromLoft = usedLoftIndividuals + (packetsOpened * packetSize);
      if (totalFromLoft > 0) {
        console.log(`[FALLBACK_LOG] Item: ${item}, Shade: ${shade}, Total: ${totalFromLoft}, Indiv: ${usedLoftIndividuals}, Pkts: ${packetsOpened}, Leftover: ${leftoverBalls}`);
        applied.set(`${item}|${shade}|loftLog`, { 
          item, 
          shade, 
          qtyFromLoft: totalFromLoft,
          individualsUsed: usedLoftIndividuals,
          packetsOpened: packetsOpened,
          leftoverBalls: leftoverBalls,
          packetSize: packetSize,
        });
      }

      console.log(`[DEDUCT_COMPLETE] Item: ${item}, Shade: ${shade}, Total Used: ${usedStore + totalFromLoft}`);
    } catch (err) {
      console.error(`[DEDUCT_FAIL] Item: ${item}, Shade: ${shade}, Error: ${(err as any).message}`);
      throw new Error(`stock deduction failed for ${item} ${shade}: ${(err as any).message}`);
    }
  }

  return applied;
}

// helpers for edit flow
async function getBillRowsWithIndexes(gsapi: any, billNo: number): Promise<{ rows: any[], rowIndexes: number[] }> {
  const res = await gsapi.spreadsheets.values.get({
    spreadsheetId: STORE_SHEET_ID,
    range: "Bill!A:M",
  });
  const allRows = res.data.values || [];
  const rows: any[] = [];
  const rowIndexes: number[] = [];
  for (let i = 0; i < allRows.length; i++) {
    const row = allRows[i];
    const bn = Number(row[0]);
    if (bn === billNo && row[1] && row[1].toString().trim()) {
      rows.push(row);
      rowIndexes.push(i + 1);
    }
  }
  return { rows, rowIndexes };
}

async function deleteBillRows(gsapi: any, sheetId: number, rowIndexes: number[]) {
  if (rowIndexes.length === 0) return;
  const sorted = [...rowIndexes].sort((a,b) => b - a);
  const requests = [];
  for (const idx of sorted) {
    requests.push({
      deleteDimension: {
        range: {
          sheetId: sheetId,
          dimension: "ROWS",
          startIndex: idx - 1,
          endIndex: idx,
        },
      },
    });
  }
  await gsapi.spreadsheets.batchUpdate({
    spreadsheetId: STORE_SHEET_ID,
    requestBody: { requests },
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const client = await auth.getClient();
    const gsapi = google.sheets({ version: "v4", auth: client as any });

    if (req.method === "GET") {
      const action = req.query.action as string;

      if (action === "getBill") {
        const billNo = Number(req.query.billNo);
        if (!billNo || billNo <= 0) {
          return res.status(400).json({ error: "invalid bill number" });
        }

        const { rows, rowIndexes } = await getBillRowsWithIndexes(gsapi, billNo);
        if (rows.length === 0) {
          return res.status(404).json({ error: "bill not found" });
        }

        const first = rows[0];
        const gpayCharges = first[10] ? Number(first[10]) : null;
        const finalTotal = Number(first[11]) || 0;
        const customerId = first[12];
        const paymentMode = first[14] || "Cash";
        const date = first[6];
        const time = first[7];
        const courier = Number(first[9]) || 0;

        let customerName = "Unknown";
        let customerPhone = "";
        if (customerId) {
          const custRes = await gsapi.spreadsheets.values.get({
            spreadsheetId: STORE_SHEET_ID,
            range: "Customers!A:C",
          });
          const custRows = custRes.data.values || [];
          const custRow = custRows.find((r: any) => r[0] === customerId);
          if (custRow) {
            customerName = custRow[1] || "Unknown";
            customerPhone = custRow[2] || "";
          }
        }

        const items = rows.map((row: any) => ({
          item: row[1],
          shade: row[2],
          qty: Number(row[3]) || 0,
          price: Number(row[4]) || 0,
          total: Number(row[5]) || 0,
          profit: Number(row[8]) || 0,
          cost: 0,
        }));

        return res.status(200).json({
          bill: {
            billNo,
            items,
            customerId,
            customerName,
            customerPhone,
            date,
            time,
            courierCharges: courier,
            paymentMode,
            gpayCharges,
            finalTotal,
            lastUpdated: first[13] || "",
            originalRowIndexes: rowIndexes,
          },
        });
      }

      const billSheet = await gsapi.spreadsheets.values.get({
        spreadsheetId: STORE_SHEET_ID,
        range: "Bill!A:A",
      });
      const all = billSheet.data.values?.flat().filter(v => v) || [];
      const nums = all.map(Number).filter(n => !isNaN(n) && n > 0);
      const last = nums.length ? Math.max(...nums) : 0;
      return res.status(200).json({ billNo: last });
    }

    if (req.method === "POST") {
      const { action } = req.query;

      if (action === "edit") {
        const {
          originalBillNo,
          items,
          courierCharges,
          finalTotal,
          paymentMode = "Cash",
          gpayCharges = null,
          customer,
          earnRate,
          redeemRate,
          originalDate,
          originalTime,
          originalRowIndexes,
        } = req.body;

        if (!originalBillNo || !items || !Array.isArray(items)) {
          return res.status(400).json({ error: "invalid edit request" });
        }

        const { date, time } = getISTDateTime();
        const timestamp = `${date} ${time}`;

        const sheetMeta = await gsapi.spreadsheets.get({
          spreadsheetId: STORE_SHEET_ID,
          fields: "sheets.properties(sheetId,title)",
        });
        const billSheetObj = (sheetMeta.data.sheets || []).find((s: any) => s.properties?.title === "Bill");
        if (!billSheetObj) {
          return res.status(500).json({ error: "bill sheet not found" });
        }
        const sheetId = billSheetObj.properties?.sheetId;
        if (!sheetId || typeof sheetId !== 'number') {
          return res.status(500).json({ error: "invalid sheet id" });
        }

        const { rows: oldRows, rowIndexes: oldIndexes } = await getBillRowsWithIndexes(gsapi, originalBillNo);
        if (oldRows.length === 0 && (!originalRowIndexes || originalRowIndexes.length === 0)) {
          return res.status(404).json({ error: "original bill rows not found" });
        }

        const indexesToDelete = originalRowIndexes && originalRowIndexes.length ? originalRowIndexes : oldIndexes;
        if (!indexesToDelete.length) {
          return res.status(400).json({ error: "no rows to delete" });
        }

        // Get Loft fallback log for this bill to properly restore Loft stock
        const fallbackLog = await getLoftFallbackLogForBill(gsapi, originalBillNo);
        console.log(`[EDIT_RESTORE_START] Retrieved ${fallbackLog.length} fallback log entries for bill ${originalBillNo}`);

        // reverse old stock
        for (const row of oldRows) {
          const itemName = row[1];
          const shadeName = row[2];
          const qty = Number(row[3]) || 0;
          if (!itemName || !shadeName || qty === 0) continue;

          // STEP 1: Restore Hook stock
          const storeRes = await gsapi.spreadsheets.values.get({
            spreadsheetId: STORE_SHEET_ID,
            range: `${escapeSheetName(itemName)}!B2:C`,
          });
          const storeRows = storeRes.data.values || [];
          const storeIdx = storeRows.findIndex(r => r[0]?.toString().trim().toLowerCase() === shadeName.toLowerCase());
          if (storeIdx !== -1) {
            const curr = Number(storeRows[storeIdx][1]) || 0;
            await gsapi.spreadsheets.values.update({
              spreadsheetId: STORE_SHEET_ID,
              range: `${escapeSheetName(itemName)}!C${storeIdx + 2}`,
              valueInputOption: "USER_ENTERED",
              requestBody: { values: [[curr + qty]] },
            });
            console.log(`[EDIT_RESTORE_HOOK] Item: ${itemName}, Shade: ${shadeName}, Restored: ${qty}`);
          }

          // STEP 2: Restore Loft fallback stock (ONLY if it was actually used as fallback)
          // Check if this item was in the Loft Fallback Log
          const fallbackEntry = fallbackLog.find(
            (log: any) => 
              log[2]?.toString().trim().toLowerCase() === itemName.toLowerCase() &&
              log[3]?.toString().trim().toLowerCase() === shadeName.toLowerCase()
          );

          if (fallbackEntry) {
            // This item used Loft fallback - restore properly!
            const individualsUsed = Number(fallbackEntry[5]) || 0;
            const packetsOpened = Number(fallbackEntry[6]) || 0;
            const leftoverBalls = Number(fallbackEntry[7]) || 0;
            const packetSize = Number(fallbackEntry[8]) || 0;

            const loftRes = await gsapi.spreadsheets.values.get({
              spreadsheetId: LOFT_SHEET_ID,
              range: `${escapeSheetName(itemName)}!A2:L`,
            });
            const loftRows = loftRes.data.values || [];
            const loftIdx = loftRows.findIndex(r => r[0]?.toString().trim().toLowerCase() === shadeName.toLowerCase());
            
            if (loftIdx !== -1) {
              const currIndiv = Number(loftRows[loftIdx][4]) || 0;
              const currPackets = Number(loftRows[loftIdx][5]) || 0;
              
              // CRITICAL: Restore individuals and packets separately
              // Only restore the leftover balls to individuals, not the original qty
              const restoredIndiv = currIndiv + leftoverBalls;
              const restoredPackets = currPackets + packetsOpened;
              
              await gsapi.spreadsheets.values.update({
                spreadsheetId: LOFT_SHEET_ID,
                range: `${escapeSheetName(itemName)}!E${loftIdx + 2}:F${loftIdx + 2}`,
                valueInputOption: "USER_ENTERED",
                requestBody: { values: [[restoredIndiv, restoredPackets]] },
              });
              console.log(`[EDIT_RESTORE_LOFT_FALLBACK] Item: ${itemName}, Shade: ${shadeName}, RestIndiv: ${restoredIndiv}, RestPkts: ${restoredPackets}, OrigIndiv: ${individualsUsed}, OrigPkts: ${packetsOpened}`);
            }
          } else {
            // This item did NOT use Loft fallback - just restore as simple individuals
            const loftRes = await gsapi.spreadsheets.values.get({
              spreadsheetId: LOFT_SHEET_ID,
              range: `${escapeSheetName(itemName)}!A2:L`,
            });
            const loftRows = loftRes.data.values || [];
            const loftIdx = loftRows.findIndex(r => r[0]?.toString().trim().toLowerCase() === shadeName.toLowerCase());
            if (loftIdx !== -1) {
              const currIndiv = Number(loftRows[loftIdx][4]) || 0;
              const currPackets = Number(loftRows[loftIdx][5]) || 0;
              // Only add as individuals since it was never a fallback usage
              await gsapi.spreadsheets.values.update({
                spreadsheetId: LOFT_SHEET_ID,
                range: `${escapeSheetName(itemName)}!E${loftIdx + 2}:F${loftIdx + 2}`,
                valueInputOption: "USER_ENTERED",
                requestBody: { values: [[currIndiv + qty, currPackets]] },
              });
              console.log(`[EDIT_RESTORE_LOFT_NOFALL] Item: ${itemName}, Shade: ${shadeName}, RestoredIndiv: ${currIndiv + qty}`);
            }
          }
        }

        const firstOld = oldRows[0];
        const oldCustomerId = firstOld ? firstOld[11] : null;
        if (oldCustomerId) {
          const custRes = await gsapi.spreadsheets.values.get({
            spreadsheetId: STORE_SHEET_ID,
            range: "Customers!A:I",
          });
          const custRows = custRes.data.values || [];
          const custIdx = custRows.findIndex(r => r[0] === oldCustomerId);
          if (custIdx !== -1) {
            const existing = custRows[custIdx];
            const oldSpend = Number(existing[6]) || 0;
            const oldBills = Number(existing[7]) || 0;
            const oldPoints = Number(existing[8]) || 0;
            const oldFinalTotal = Number(firstOld[10]) || 0;
            await gsapi.spreadsheets.values.update({
              spreadsheetId: STORE_SHEET_ID,
              range: `Customers!G${custIdx + 2}:I${custIdx + 2}`,
              valueInputOption: "USER_ENTERED",
              requestBody: {
                values: [[oldSpend - oldFinalTotal, oldBills - 1, oldPoints]],
              },
            });
          }
        }

        await deleteBillRows(gsapi, sheetId, indexesToDelete);

        // validate new items stock
        const validations = await validateAllItemsStock(gsapi, items);
        console.log(`[EDIT_VALIDATE_STOCK] ${validations.length} items validated for edit`);
        
        const failed = validations.find(v => !v.isValid);
        if (failed) {
          console.error(`[EDIT_VALIDATE_FAILED] Item: ${failed.item}, Error: ${failed.errorMessage}`);
          return res.status(400).json({ error: failed.errorMessage });
        }

        const ops = validations
          .filter(v => !items.find(i => i.item === v.item && i.shade === v.shade)?.misc)
          .map(v => {
            return {
              item: v.item,
              shade: v.shade,
              storeRowIndex: v.storeRowIndex,
              storeStock: v.storeStock,
              loftRowIndex: v.loftRowIndex,
              loftIndividuals: v.loftIndividuals,
              loftPackets: v.loftPackets,
              packetSize: v.packetSize,
              qty: v.qty,
              timestamp,
            };
          });
        const applied = await deductAllItemsStock(gsapi, ops);

        // Collect fallback usage for edit toast notifications
        const fallbackUsage: Array<{ item: string; shade: string; individualsUsed: number; packetsOpened: number }> = [];
        
        // Log Loft fallback for edit flow as well
        for (const [key, op] of applied) {
          if (key.includes("loftLog")) {
            console.log(`[EDIT_FALLBACK_LOG] Found loftLog entry: ${key}`);
            fallbackUsage.push({
              item: op.item,
              shade: op.shade,
              individualsUsed: op.individualsUsed,
              packetsOpened: op.packetsOpened,
            });
            await logLoftFallback(
              gsapi, 
              originalBillNo, 
              op.item, 
              op.shade, 
              op.qtyFromLoft,
              op.individualsUsed,
              op.packetsOpened,
              op.leftoverBalls,
              op.packetSize,
              timestamp
            ).catch(err => console.error(`[EDIT_FALLBACK_LOG_ERROR] Error: ${err.message}`));
          }
        }

        let newCustomerId = "";
        try {
          const custRes = await gsapi.spreadsheets.values.get({
            spreadsheetId: STORE_SHEET_ID,
            range: "Customers!A:I",
          });
          const custRows = custRes.data.values || [];
          const phoneNormalized = normalizePhone(customer.phone);

          let existingIdx = -1;
          for (let i = 0; i < custRows.length; i++) {
            const p1 = normalizePhone(custRows[i][2]?.toString() || "");
            const p2 = normalizePhone(custRows[i][3]?.toString() || "");
            if (p1 === phoneNormalized || p2 === phoneNormalized) {
              existingIdx = i;
              break;
            }
          }

          const pointsEarned = Math.floor((finalTotal / 100) * earnRate);

          if (existingIdx === -1) {
            newCustomerId = generateCustomerId(custRows.filter((row: any) => row[0]?.toString().startsWith("LMS-")));
            await gsapi.spreadsheets.values.append({
              spreadsheetId: STORE_SHEET_ID,
              range: "Customers!A:I",
              valueInputOption: "USER_ENTERED",
              requestBody: {
                values: [[
                  newCustomerId,
                  customer.name || "",
                  phoneNormalized,
                  normalizePhone(customer.phone2 || ""),
                  originalDate,
                  originalDate,
                  finalTotal,
                  1,
                  pointsEarned,
                ]],
              },
            });
          } else {
            newCustomerId = custRows[existingIdx][0];
            const existing = custRows[existingIdx];
            const currentSpend = Number(existing[6]) || 0;
            const currentBills = Number(existing[7]) || 0;
            const currentPoints = Number(existing[8]) || 0;
            const newPoints = currentPoints + pointsEarned;
            const updateRow = existingIdx + 2;
            if (customer.name && customer.name !== existing[1]) {
              await gsapi.spreadsheets.values.update({
                spreadsheetId: STORE_SHEET_ID,
                range: `Customers!B${updateRow}`,
                valueInputOption: "USER_ENTERED",
                requestBody: { values: [[customer.name]] },
              });
            }
            const existingPhone2 = normalizePhone(existing[3]?.toString() || "");
            const newPhone2 = normalizePhone(customer.phone2 || "");
            if (newPhone2 && newPhone2 !== existingPhone2) {
              await gsapi.spreadsheets.values.update({
                spreadsheetId: STORE_SHEET_ID,
                range: `Customers!D${updateRow}`,
                valueInputOption: "USER_ENTERED",
                requestBody: { values: [[newPhone2]] },
              });
            }
            await gsapi.spreadsheets.values.update({
              spreadsheetId: STORE_SHEET_ID,
              range: `Customers!F${updateRow}:I${updateRow}`,
              valueInputOption: "USER_ENTERED",
              requestBody: {
                values: [[originalDate, currentSpend + finalTotal, currentBills + 1, newPoints]],
              },
            });
          }
        } catch (err) {
          console.error("customer upsert failed in edit:", err);
          newCustomerId = `TEMP-${customer.phone.replace(/[^0-9]/g, "")}`;
        }

        await ensureBillSheetColumns(gsapi);

        const profitSheet = await gsapi.spreadsheets.values.get({
          spreadsheetId: STORE_SHEET_ID,
          range: "Profit!A2:C",
        });
        const profitRows = profitSheet.data.values || [];
        const costMap = new Map<string, number>();
        for (const row of profitRows) {
          const profitItem = row[0]?.toString().trim().toLowerCase();
          const profitShade = row[1]?.toString().trim().toLowerCase();
          const cost = Number(row[2]) || 0;
          if (profitItem) {
            const key = `${profitItem}|${profitShade || ""}`;
            costMap.set(key, cost);
          }
        }

        const enhancedItems = items.map((entry: any) => {
          const itemKey = `${entry.item.toLowerCase()}|${entry.shade?.toLowerCase() || ""}`;
          let costPrice = costMap.get(itemKey) || 0;
          if (costPrice === 0) {
            const fallback = `${entry.item.toLowerCase()}|`;
            costPrice = costMap.get(fallback) || 0;
          }
          const qtyNum = Number(entry.qty) || 0;
          const priceNum = Number(entry.price) || 0;
          const total = qtyNum * priceNum;
          const profit = total - (costPrice * qtyNum);
          return { ...entry, total, profit, cost: costPrice };
        });

        const newRows = enhancedItems.map((entry: any) => [
          originalBillNo,
          entry.item,
          entry.shade,
          entry.qty,
          entry.price,
          entry.total,
          originalDate,
          originalTime,
          entry.profit,
          courierCharges > 0 ? courierCharges : "",
          gpayCharges !== null ? gpayCharges : "",
          finalTotal,
          newCustomerId,
          timestamp,
          paymentMode,
        ]);

        await gsapi.spreadsheets.values.append({
          spreadsheetId: STORE_SHEET_ID,
          range: "Bill!A:O",
          valueInputOption: "USER_ENTERED",
          requestBody: { values: newRows },
        });

        return res.status(200).json({ success: true, billNo: originalBillNo, fallbackUsage });
      }

      // normal new bill
      const {
        items,
        finalTotal = 0,
        courierCharges = 0,
        paymentMode = "Cash",
        gpayCharges = null,
        customer,
        earnRate = 0,
      } = req.body;

      if (!items || !Array.isArray(items)) {
        return res.status(400).json({ error: "invalid items" });
      }
      if (items.length === 0) {
        return res.status(400).json({ error: "bill must have items" });
      }
      if (!customer?.phone || customer.phone.replace(/[^0-9]/g, "").length < 10) {
        return res.status(400).json({ error: "customer phone required (10 digits)" });
      }
      const isCourier = customer.type === "courier" || customer.courier === true;
      if (isCourier && courierCharges <= 0) {
        return res.status(400).json({ error: "courier charges required for courier orders" });
      }

      const { date, time } = getISTDateTime();
      const timestamp = `${date} ${time}`;

      const billSheet = await gsapi.spreadsheets.values.get({
        spreadsheetId: STORE_SHEET_ID,
        range: "Bill!A:A",
      });
      const all = billSheet.data.values?.flat().filter(v => v) || [];
      const nums = all.map(Number).filter(n => !isNaN(n) && n > 0);
      const lastBillNo = nums.length ? Math.max(...nums) : 0;
      const billNo = lastBillNo + 1;

      await ensureBillSheetColumns(gsapi);

      const validations = await validateAllItemsStock(gsapi, items);
      console.log(`[VALIDATE_STOCK] ${validations.length} items validated`);
      
      const failed = validations.find(v => !v.isValid);
      if (failed) {
        console.error(`[VALIDATE_FAILED] Item: ${failed.item}, Error: ${failed.errorMessage}`);
        return res.status(400).json({ error: failed.errorMessage });
      }

      const ops = validations
        .filter(v => !items.find(i => i.item === v.item && i.shade === v.shade)?.misc)
        .map(v => {
          return {
            item: v.item,
            shade: v.shade,
            storeRowIndex: v.storeRowIndex,
            storeStock: v.storeStock,
            loftRowIndex: v.loftRowIndex,
            loftIndividuals: v.loftIndividuals,
            loftPackets: v.loftPackets,
            packetSize: v.packetSize,
            qty: v.qty,
            timestamp,
          };
        });

      console.log(`[DEDUCT_OPS] Created ${ops.length} deduction operations`);

      let applied = new Map();
      try {
        applied = await deductAllItemsStock(gsapi, ops);
      } catch (err) {
        for (const [key, op] of applied) {
          if (key.includes("store")) {
            await restoreStoreStock(gsapi, op.item, op.storeRowIndex + 2, op.oldStore).catch(console.error);
          }
          if (key.includes("loft")) {
            await restoreLoftStock(gsapi, op.item, op.loftRowIndex + 2, op.oldIndiv, op.oldPackets).catch(console.error);
          }
        }
        return res.status(500).json({ error: "stock deduction failed" });
      }

      // Collect fallback usage for toast notifications
      const fallbackUsage: Array<{ item: string; shade: string; individualsUsed: number; packetsOpened: number }> = [];
      for (const [key, op] of applied) {
        if (key.includes("loftLog")) {
          console.log(`[SAVE_FALLBACK_LOG] Found loftLog entry: ${key}`);
          fallbackUsage.push({
            item: op.item,
            shade: op.shade,
            individualsUsed: op.individualsUsed,
            packetsOpened: op.packetsOpened,
          });
          await logLoftFallback(
            gsapi, 
            billNo, 
            op.item, 
            op.shade, 
            op.qtyFromLoft,
            op.individualsUsed,
            op.packetsOpened,
            op.leftoverBalls,
            op.packetSize,
            timestamp
          ).catch(err => console.error(`[SAVE_FALLBACK_LOG_ERROR] Error: ${err.message}`));
        }
      }

      // customer upsert new bill
      let customerId = "";
      try {
        const custRes = await gsapi.spreadsheets.values.get({
          spreadsheetId: STORE_SHEET_ID,
          range: "Customers!A2:I",
        });
        const custRows = custRes.data.values || [];
        const phoneNormalized = normalizePhone(customer.phone);

        let existingIdx = -1;
        for (let i = 0; i < custRows.length; i++) {
          const p1 = normalizePhone(custRows[i][2]?.toString() || "");
          const p2 = normalizePhone(custRows[i][3]?.toString() || "");
          if (p1 === phoneNormalized || p2 === phoneNormalized) {
            existingIdx = i;
            break;
          }
        }

        const pointsEarned = Math.floor((finalTotal / 100) * earnRate);

        if (existingIdx === -1) {
          customerId = generateCustomerId(custRows.filter((row: any) => row[0]?.toString().startsWith("LMS-")));
          await gsapi.spreadsheets.values.append({
            spreadsheetId: STORE_SHEET_ID,
            range: "Customers!A:I",
            valueInputOption: "USER_ENTERED",
            requestBody: {
              values: [[
                customerId,
                customer.name || "",
                phoneNormalized,
                normalizePhone(customer.phone2 || ""),
                date,
                date,
                finalTotal,
                1,
                pointsEarned,
              ]],
            },
          });
        } else {
          customerId = custRows[existingIdx][0];
          const existing = custRows[existingIdx];
          const currentSpend = Number(existing[6]) || 0;
          const currentBills = Number(existing[7]) || 0;
          const currentPoints = Number(existing[8]) || 0;
          const newPoints = currentPoints + pointsEarned;
          const updateRow = existingIdx + 2;
          if (customer.name && customer.name !== existing[1]) {
            await gsapi.spreadsheets.values.update({
              spreadsheetId: STORE_SHEET_ID,
              range: `Customers!B${updateRow}`,
              valueInputOption: "USER_ENTERED",
              requestBody: { values: [[customer.name]] },
            });
          }
          const existingPhone2 = normalizePhone(existing[3]?.toString() || "");
          const newPhone2 = normalizePhone(customer.phone2 || "");
          if (newPhone2 && newPhone2 !== existingPhone2) {
            await gsapi.spreadsheets.values.update({
              spreadsheetId: STORE_SHEET_ID,
              range: `Customers!D${updateRow}`,
              valueInputOption: "USER_ENTERED",
              requestBody: { values: [[newPhone2]] },
            });
          }
          await gsapi.spreadsheets.values.update({
            spreadsheetId: STORE_SHEET_ID,
            range: `Customers!F${updateRow}:I${updateRow}`,
            valueInputOption: "USER_ENTERED",
            requestBody: {
              values: [[date, currentSpend + finalTotal, currentBills + 1, newPoints]],
            },
          });
        }
      } catch (err) {
        console.error("customer upsert failed:", err);
        customerId = `TEMP-${customer.phone.replace(/[^0-9]/g, "")}`;
      }

      const profitSheet = await gsapi.spreadsheets.values.get({
        spreadsheetId: STORE_SHEET_ID,
        range: "Profit!A2:C",
      });
      const profitRows = profitSheet.data.values || [];
      const costMap = new Map<string, number>();
      for (const row of profitRows) {
        const profitItem = row[0]?.toString().trim().toLowerCase();
        const profitShade = row[1]?.toString().trim().toLowerCase();
        const cost = Number(row[2]) || 0;
        if (profitItem) {
          const key = `${profitItem}|${profitShade || ""}`;
          costMap.set(key, cost);
        }
      }

      const enhancedItems = items.map((entry: any) => {
        const itemKey = `${entry.item.toLowerCase()}|${entry.shade?.toLowerCase() || ""}`;
        let costPrice = costMap.get(itemKey) || 0;
        if (costPrice === 0) {
          const fallback = `${entry.item.toLowerCase()}|`;
          costPrice = costMap.get(fallback) || 0;
        }
        const qtyNum = Number(entry.qty) || 0;
        const priceNum = Number(entry.price) || 0;
        const total = qtyNum * priceNum;
        const profit = total - (costPrice * qtyNum);
        return { ...entry, total, profit, cost: costPrice };
      });

      const billRows = enhancedItems.map((entry: any) => [
        billNo,
        entry.item,
        entry.shade,
        entry.qty,
        entry.price,
        entry.total,
        date,
        time,
        entry.profit,
        courierCharges > 0 ? courierCharges : "",
        gpayCharges !== null ? gpayCharges : "",
        finalTotal,
        customerId,
        timestamp,
        paymentMode,
      ]);

      await gsapi.spreadsheets.values.append({
        spreadsheetId: STORE_SHEET_ID,
        range: "Bill!A:O",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: billRows },
      });

      return res.status(200).json({ success: true, billNo, customerId, fallbackUsage });
    }

    res.status(405).json({ error: "method not allowed" });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err.message || "failed to process bill" });
  }
}