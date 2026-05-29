// api/bill.ts
import { google } from "googleapis";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// constants
const BILL_COLUMNS = {
  BILL_NO: 0,
  ITEM: 1,
  SHADE: 2,
  QTY: 3,
  PRICE: 4,
  PROFIT: 5,
  TOTAL: 6,
  COURIER: 7,
  GPAY_CHARGES: 8,
  FINAL_TOTAL: 9,
  CUSTOMER_ID: 10,
  DATE: 11,
  TIME: 12,
  LAST_UPDATED: 13,
  PAYMENT_MODE: 14,
} as const;

const CUSTOMER_COLUMNS = {
  ID: 0,
  NAME: 1,
  PHONE1: 2,
  PHONE2: 3,
  FIRST_VISIT: 4,
  LAST_VISIT: 5,
  EXPENDITURE: 6,
  TOTAL_BILLS: 7,
  POINTS: 8,
} as const;

const auth = new google.auth.GoogleAuth({
  credentials: (() => {
    try {
      return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT!);
    } catch (err) {
      console.error("[init_error] Failed to parse service account:", err);
      throw new Error("Invalid google service account credentials.");
    }
  })(),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const STORE_SHEET_ID = process.env.SHEET_ID!;
const LOFT_SHEET_ID = process.env.LOFT_SHEET_ID!;


// helpers
function getISTDateTime() {
  const now = new Date();
  const date = now.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
  const time = now.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });
  return { date, time };
}

function escapeSheetName(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

function normalisePhone(phone?: string | null): string | null {
  if (phone === undefined || phone === null) return null;
  const input = phone.toString().trim();
  if (input === "") return null;
  if (input.startsWith("+")) return input;
  const digits = input.replace(/[^0-9]/g, "");
  if (digits.length < 10) return null;
  return "+91" + digits.slice(-10);
}

// bill number with optimistic retry
async function getNextBillNo(gsapi: any, maxRetries = 5): Promise<number> {
  const settingsRange = "Settings!E1";
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const counterRes = await gsapi.spreadsheets.values.get({
      spreadsheetId: STORE_SHEET_ID,
      range: settingsRange,
    });
    let current = parseInt(counterRes.data.values?.[0]?.[0] || "0", 10);
    if (isNaN(current)) current = 0;
    const candidate = current + 1;

    const existingRes = await gsapi.spreadsheets.values.get({
      spreadsheetId: STORE_SHEET_ID,
      range: "Bill!A:A",
    });
    const existingBills = existingRes.data.values?.flat().map(Number) || [];
    if (existingBills.includes(candidate)) {
      const actualMax = Math.max(...existingBills, 0);
      const corrected = actualMax + 1;
      await gsapi.spreadsheets.values.update({
        spreadsheetId: STORE_SHEET_ID,
        range: settingsRange,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[corrected]] },
      });
      continue;
    }

    await gsapi.spreadsheets.values.update({
      spreadsheetId: STORE_SHEET_ID,
      range: settingsRange,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[candidate]] },
    });

    const confirmRes = await gsapi.spreadsheets.values.get({
      spreadsheetId: STORE_SHEET_ID,
      range: settingsRange,
    });
    const confirmed = parseInt(confirmRes.data.values?.[0]?.[0] || "0", 10);
    if (confirmed === candidate) return candidate;

    await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 20));
  }
  throw new Error("failed to generate unique bill number");
}

function generateCustomerId(existingIds: string[]): string {
  const ids = existingIds
    .filter((id) => id?.startsWith("LMS-"))
    .map((id) => Number(id.replace("LMS-", "")))
    .filter((n) => !isNaN(n));
  const next = ids.length > 0 ? Math.max(...ids) + 1 : 1;
  return `LMS-${String(next).padStart(4, "0")}`;
}

async function findCustomerByPhone(gsapi: any, phone: string): Promise<any | null> {
  const custRes = await gsapi.spreadsheets.values.get({
    spreadsheetId: STORE_SHEET_ID,
    range: "Customers!A2:I",
  });
  const rows = custRes.data.values || [];
  const normalisedSearch = normalisePhone(phone);
  if (!normalisedSearch) return null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const p1 = normalisePhone(row[CUSTOMER_COLUMNS.PHONE1]?.toString());
    const p2 = normalisePhone(row[CUSTOMER_COLUMNS.PHONE2]?.toString());
    if (p1 === normalisedSearch || p2 === normalisedSearch) {
      return { rowIndex: i, data: row };
    }
  }
  return null;
}

async function upsertCustomer(
  gsapi: any,
  customer: any,
  date: string,
  finalTotal: number,
  earnRate: number
): Promise<string> {
  const phoneNormalised = normalisePhone(customer.phone);
  if (!phoneNormalised) throw new Error("Valid customer phone required");

  const existing = await findCustomerByPhone(gsapi, customer.phone);
  const pointsEarned = Math.floor(finalTotal * earnRate);

  if (!existing) {
    const allIdsRes = await gsapi.spreadsheets.values.get({
      spreadsheetId: STORE_SHEET_ID,
      range: "Customers!A:A",
    });
    const existingIds = (allIdsRes.data.values || []).flat().filter(Boolean);
    const newId = generateCustomerId(existingIds);
    await gsapi.spreadsheets.values.append({
      spreadsheetId: STORE_SHEET_ID,
      range: "Customers!A:I",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          newId,
          customer.name || "",
          phoneNormalised,
          normalisePhone(customer.phone2),
          date,
          date,
          finalTotal,
          1,
          pointsEarned,
        ]],
      },
    });
    return newId;
  }

  const { rowIndex, data: row } = existing;
  const customerId = row[CUSTOMER_COLUMNS.ID];
  const currentSpend = Number(row[CUSTOMER_COLUMNS.EXPENDITURE]) || 0;
  const currentBills = Number(row[CUSTOMER_COLUMNS.TOTAL_BILLS]) || 0;
  const currentPoints = Number(row[CUSTOMER_COLUMNS.POINTS]) || 0;
  const newPoints = currentPoints + pointsEarned;
  const updateRow = rowIndex + 2;

  if (customer.name && customer.name !== row[CUSTOMER_COLUMNS.NAME]) {
    await gsapi.spreadsheets.values.update({
      spreadsheetId: STORE_SHEET_ID,
      range: `Customers!B${updateRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[customer.name]] },
    });
  }
  const newphone2 = normalisePhone(customer.phone2);
  const oldphone2 = normalisePhone(row[CUSTOMER_COLUMNS.PHONE2]?.toString());
  if (newphone2 && newphone2 !== oldphone2) {
    await gsapi.spreadsheets.values.update({
      spreadsheetId: STORE_SHEET_ID,
      range: `Customers!D${updateRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[newphone2]] },
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
  return customerId;
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

async function findLoftStockEntry(gsapi: any, item: string, shade: string): Promise<any | null> {
  // try item sheet
  try {
    const res = await gsapi.spreadsheets.values.get({
      spreadsheetId: LOFT_SHEET_ID,
      range: `${escapeSheetName(item)}!A2:L`,
    });
    const rows = res.data.values || [];
    const rowIndex = rows.findIndex(
      (r: any) => r[0]?.toString().trim().toLowerCase() === shade.toLowerCase()
    );
    if (rowIndex !== -1) {
      const individuals = Number(rows[rowIndex][4]) || 0;
      const packets = Number(rows[rowIndex][5]) || 0;
      const packetSize = await getPacketSize(gsapi, item);
      return { sheetName: item, rowIndex, individuals, packets, packetSize, isMisc: false };
    }
  } catch {}
  // try miscellaneous sheet
  try {
    const miscRes = await gsapi.spreadsheets.values.get({
      spreadsheetId: LOFT_SHEET_ID,
      range: "miscellaneous!A2:L",
    });
    const rows = miscRes.data.values || [];
    const rowIndex = rows.findIndex(
      (r: any) =>
        r[0]?.toString().trim().toLowerCase() === item.toLowerCase() &&
        r[1]?.toString().trim().toLowerCase() === shade.toLowerCase()
    );
    if (rowIndex !== -1) {
      const individuals = Number(rows[rowIndex][4]) || 0;
      const packets = Number(rows[rowIndex][5]) || 0;
      const packetSize = await getPacketSize(gsapi, item);
      return { sheetName: "miscellaneous", rowIndex, individuals, packets, packetSize, isMisc: true };
    }
  } catch {}
  return null;
}

async function getStoreStock(gsapi: any, item: string, shade: string): Promise<{ rowIndex: number; stock: number }> {
  try {
    const res = await gsapi.spreadsheets.values.get({
      spreadsheetId: STORE_SHEET_ID,
      range: `${escapeSheetName(item)}!B2:C`,
    });
    const rows = res.data.values || [];
    const rowIndex = rows.findIndex(
      (r: any) => r[0]?.toString().trim().toLowerCase() === shade.toLowerCase()
    );
    if (rowIndex !== -1) {
      const stock = Number(rows[rowIndex][1]) || 0;
      return { rowIndex, stock };
    }
  } catch {}
  return { rowIndex: -1, stock: 0 };
}

async function deductStoreStock(
  gsapi: any,
  item: string,
  shade: string,
  rowIndex: number,
  currentStock: number,
  deduction: number,
  timestamp: string
): Promise<number> {
  const newStock = Math.max(0, currentStock - deduction);
  const used = currentStock - newStock;
  if (rowIndex !== -1 && used > 0) {
    await gsapi.spreadsheets.values.update({
      spreadsheetId: STORE_SHEET_ID,
      range: `${escapeSheetName(item)}!C${rowIndex + 2}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[newStock]] },
    });
    await gsapi.spreadsheets.values.update({
      spreadsheetId: STORE_SHEET_ID,
      range: `${escapeSheetName(item)}!E${rowIndex + 2}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[timestamp]] },
    });
  }
  return used;
}

async function deductLoftStock(gsapi: any, entry: any, needed: number): Promise<any> {
  let remaining = needed;
  let individualsUsed = 0;
  let packetsOpened = 0;
  let leftoverBalls = 0;
  let { individuals, packets, packetSize, sheetName, rowIndex, isMisc } = entry;

  individualsUsed = Math.min(remaining, individuals);
  let newIndiv = individuals - individualsUsed;
  remaining -= individualsUsed;

  if (remaining > 0 && packets > 0 && packetSize > 0) {
    const needPackets = Math.ceil(remaining / packetSize);
    packetsOpened = Math.min(needPackets, packets);
    const ballsFromPackets = packetsOpened * packetSize;
    const usedFromPackets = Math.min(remaining, ballsFromPackets);
    leftoverBalls = ballsFromPackets - usedFromPackets;
    newIndiv = leftoverBalls;
    const newPackets = packets - packetsOpened;
    remaining -= usedFromPackets;
    const range = `${escapeSheetName(sheetName)}!E${rowIndex + 2}:F${rowIndex + 2}`;
    await gsapi.spreadsheets.values.update({
      spreadsheetId: LOFT_SHEET_ID,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[newIndiv, newPackets]] },
    });
    return { individualsUsed, packetsOpened, leftoverBalls, newIndiv, newPackets };
  } else {
    const range = `${escapeSheetName(sheetName)}!E${rowIndex + 2}`;
    await gsapi.spreadsheets.values.update({
      spreadsheetId: LOFT_SHEET_ID,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[newIndiv]] },
    });
    return { individualsUsed, packetsOpened: 0, leftoverBalls: 0, newIndiv, newPackets: packets };
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
    const sheetMeta = await gsapi.spreadsheets.get({
      spreadsheetId: STORE_SHEET_ID,
      fields: "sheets.properties.title",
    });
    const sheetExists = (sheetMeta.data.sheets || []).some(
      (s: any) => s.properties?.title === "Loft Fallback Log"
    );
    if (!sheetExists) {
      await gsapi.spreadsheets.batchUpdate({
        spreadsheetId: STORE_SHEET_ID,
        requestBody: {
          requests: [{ addSheet: { properties: { title: "Loft Fallback Log" } } }],
        },
      });
      await gsapi.spreadsheets.values.update({
        spreadsheetId: STORE_SHEET_ID,
        range: "Loft Fallback Log!A1:I1",
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [["timestamp", "bill no", "item", "shade", "total from loft", "individual balls used", "packets opened", "leftover balls", "packet size"]],
        },
      });
    }
    await gsapi.spreadsheets.values.append({
      spreadsheetId: STORE_SHEET_ID,
      range: "Loft Fallback Log!A:I",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[timestamp, billNo, item, shade, qtyFromLoft, individualsUsed, packetsOpened, leftoverBalls, packetSize]],
      },
    });
  } catch (err) {
    console.error(`[log_fallback_error] ${(err as any).message}`);
  }
}

async function getLoftFallbackLogForBill(gsapi: any, billNo: number): Promise<any[]> {
  try {
    const logRes = await gsapi.spreadsheets.values.get({
      spreadsheetId: STORE_SHEET_ID,
      range: "Loft Fallback Log!A2:I",
    });
    const logRows = logRes.data.values || [];
    return logRows.filter((row: any) => Number(row[1]) === billNo);
  } catch (err) {
    console.error(`[log_query_error] ${(err as any).message}`);
    return [];
  }
}

async function ensureBillSheetColumns(gsapi: any) {
  const sheetMeta = await gsapi.spreadsheets.get({
    spreadsheetId: STORE_SHEET_ID,
    fields: "sheets.properties(title,gridProperties,sheetId)",
  });
  const billSheet = (sheetMeta.data.sheets || []).find((s: any) => s.properties?.title === "Bill");
  if (!billSheet) return;
  const currentCols = billSheet.properties?.gridProperties?.columnCount || 0;
  const requiredCols = Object.keys(BILL_COLUMNS).length;
  if (currentCols < requiredCols) {
    await gsapi.spreadsheets.batchUpdate({
      spreadsheetId: STORE_SHEET_ID,
      requestBody: {
        requests: [
          {
            updateSheetProperties: {
              properties: {
                sheetId: billSheet.properties?.sheetId,
                gridProperties: { columnCount: requiredCols },
              },
              fields: "gridProperties.columnCount",
            },
          },
        ],
      },
    });
    const expectedHeaders = [
      "bill no", "item", "shade / variant", "qty", "price", "profit", "total", "courier charges", "gpay charges", "final total", "customer id", "date", "time", "last updated", "payment mode",
    ];
    for (let i = 0; i < expectedHeaders.length; i++) {
      await gsapi.spreadsheets.values.update({
        spreadsheetId: STORE_SHEET_ID,
        range: `Bill!${String.fromCharCode(65 + i)}1`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[expectedHeaders[i]]] },
      });
    }
  }
}

async function getCostMap(gsapi: any): Promise<Map<string, number>> {
  const profitRes = await gsapi.spreadsheets.values.get({
    spreadsheetId: STORE_SHEET_ID,
    range: "Profit!A2:C",
  });
  const rows = profitRes.data.values || [];
  const costMap = new Map<string, number>();
  for (const row of rows) {
    const item = row[0]?.toString().trim().toLowerCase();
    const shade = row[1]?.toString().trim().toLowerCase();
    const cost = Number(row[2]) || 0;
    if (item) {
      const key = shade ? `${item}|${shade}` : `${item}|`;
      costMap.set(key, cost);
    }
  }
  return costMap;
}

function calculateItemProfit(item: any, costMap: Map<string, number>): { total: number; profit: number } {
  const qty = Number(item.qty) || 0;
  const price = Number(item.price) || 0;
  const total = qty * price;
  const itemKey = `${item.item.toLowerCase()}|${item.shade?.toLowerCase() || ""}`;
  let costPrice = costMap.get(itemKey) || 0;
  if (costPrice === 0) {
    const fallbackKey = `${item.item.toLowerCase()}|`;
    costPrice = costMap.get(fallbackKey) || 0;
  }
  const profit = total - costPrice * qty;
  return { total, profit };
}

function createBillRow(
  billNo: number,
  item: any,
  profit: number,
  total: number,
  courierCharges: number,
  gpayCharges: number | null,
  finalTotal: number,
  customerId: string,
  date: string,
  time: string,
  timestamp: string,
  paymentMode: string
): any[] {
  return [
    billNo,
    item.item,
    item.shade,
    item.qty,
    item.price,
    profit,
    total,
    courierCharges > 0 ? courierCharges : "",
    gpayCharges !== null ? gpayCharges : "",
    finalTotal,
    customerId,
    date,
    time,
    timestamp,
    paymentMode,
  ];
}


// main handler
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
        const billRes = await gsapi.spreadsheets.values.get({
          spreadsheetId: STORE_SHEET_ID,
          range: "Bill!A:O",
        });
        const allRows = billRes.data.values || [];
        const billRows = allRows.filter((row: any) => Number(row[BILL_COLUMNS.BILL_NO]) === billNo);
        if (billRows.length === 0) {
          return res.status(404).json({ error: "bill not found" });
        }
        const firstRow = billRows[0];
        const items = billRows.map((row: any) => ({
          item: row[BILL_COLUMNS.ITEM],
          shade: row[BILL_COLUMNS.SHADE],
          qty: Number(row[BILL_COLUMNS.QTY]) || 0,
          price: Number(row[BILL_COLUMNS.PRICE]) || 0,
          total: Number(row[BILL_COLUMNS.TOTAL]) || 0,
          profit: Number(row[BILL_COLUMNS.PROFIT]) || 0,
          cost: 0,
        }));
        let customerName = "unknown";
        let customerPhone = "";
        const customerId = firstRow[BILL_COLUMNS.CUSTOMER_ID];
        if (customerId) {
          const custRes = await gsapi.spreadsheets.values.get({
            spreadsheetId: STORE_SHEET_ID,
            range: "Customers!A:C",
          });
          const custRows = custRes.data.values || [];
          const custRow = custRows.find((r: any) => r[0] === customerId);
          if (custRow) {
            customerName = custRow[1] || "unknown";
            customerPhone = custRow[2] || "";
          }
        }
        return res.status(200).json({
          bill: {
            billNo,
            items,
            customerId,
            customerName,
            customerPhone,
            date: firstRow[BILL_COLUMNS.DATE] || "",
            time: firstRow[BILL_COLUMNS.TIME] || "",
            courierCharges: Number(firstRow[BILL_COLUMNS.COURIER]) || 0,
            paymentMode: firstRow[BILL_COLUMNS.PAYMENT_MODE] || "cash",
            gpayCharges: firstRow[BILL_COLUMNS.GPAY_CHARGES] ? Number(firstRow[BILL_COLUMNS.GPAY_CHARGES]) : null,
            finalTotal: Number(firstRow[BILL_COLUMNS.FINAL_TOTAL]) || 0,
            lastUpdated: firstRow[BILL_COLUMNS.LAST_UPDATED] || "",
          },
        });
      }
      const counterRes = await gsapi.spreadsheets.values.get({
        spreadsheetId: STORE_SHEET_ID,
        range: "Settings!E1",
      });
      let last = parseInt(counterRes.data.values?.[0]?.[0] || "0", 10);
      if (isNaN(last)) last = 0;
      return res.status(200).json({ billNo: last });
    }

    if (req.method === "POST") {
      const { action } = req.query;

      // edit bill
      if (action === "edit") {
        const {
          originalBillNo,
          items,
          courierCharges,
          finalTotal,
          paymentMode = "cash",
          gpayCharges = null,
          customer,
          earnRate,
          originalDate,
          originalTime,
        } = req.body;

        if (!originalBillNo || typeof originalBillNo !== "number" || originalBillNo <= 0) {
          return res.status(400).json({ error: "originalBillNo must be a positive number" });
        }
        if (!items || !Array.isArray(items)) {
          return res.status(400).json({ error: "items must be an array" });
        }
        if (!customer || !customer.phone) {
          return res.status(400).json({ error: "customer with phone is required" });
        }

        const { date, time } = getISTDateTime();
        const timestamp = `${date} ${time}`;

        // fetch old bill rows and fallback logs
        const billRes = await gsapi.spreadsheets.values.get({
          spreadsheetId: STORE_SHEET_ID,
          range: "Bill!A:O",
        });
        const allRows = billRes.data.values || [];
        const oldBillRows = allRows.filter((row: any) => Number(row[BILL_COLUMNS.BILL_NO]) === originalBillNo);
        if (oldBillRows.length === 0) {
          return res.status(404).json({ error: "original bill not found" });
        }
        const oldRowIndexes = oldBillRows.map((_, idx) => idx + 1);
        const fallbackLog = await getLoftFallbackLogForBill(gsapi, originalBillNo);

        // reverse old stock
        for (const row of oldBillRows) {
          const itemName = row[BILL_COLUMNS.ITEM];
          const shadeName = row[BILL_COLUMNS.SHADE];
          const qty = Number(row[BILL_COLUMNS.QTY]) || 0;
          if (!itemName || !shadeName || qty === 0) continue;

          const storeInfo = await getStoreStock(gsapi, itemName, shadeName);
          if (storeInfo.rowIndex !== -1) {
            const newStock = storeInfo.stock + qty;
            await gsapi.spreadsheets.values.update({
              spreadsheetId: STORE_SHEET_ID,
              range: `${escapeSheetName(itemName)}!C${storeInfo.rowIndex + 2}`,
              valueInputOption: "USER_ENTERED",
              requestBody: { values: [[newStock]] },
            });
          }

          const logEntry = fallbackLog.find(
            (log: any) =>
              log[2]?.toString().trim().toLowerCase() === itemName.toLowerCase() && log[3]?.toString().trim().toLowerCase() === shadeName.toLowerCase()
          );
          if (logEntry) {
            const individualsUsed = Number(logEntry[5]) || 0;
            const packetsOpened = Number(logEntry[6]) || 0;
            const leftoverBalls = Number(logEntry[7]) || 0;
            const loftEntry = await findLoftStockEntry(gsapi, itemName, shadeName);
            if (loftEntry) {
              const newIndiv = loftEntry.individuals + leftoverBalls;
              const newPackets = loftEntry.packets + packetsOpened;
              const range = `${escapeSheetName(loftEntry.sheetName)}!E${loftEntry.rowIndex + 2}:F${loftEntry.rowIndex + 2}`;
              await gsapi.spreadsheets.values.update({
                spreadsheetId: LOFT_SHEET_ID,
                range,
                valueInputOption: "USER_ENTERED",
                requestBody: { values: [[newIndiv, newPackets]] },
              });
            }
          } else {
            const loftEntry = await findLoftStockEntry(gsapi, itemName, shadeName);
            if (loftEntry) {
              const newIndiv = loftEntry.individuals + qty;
              const range = `${escapeSheetName(loftEntry.sheetName)}!E${loftEntry.rowIndex + 2}`;
              await gsapi.spreadsheets.values.update({
                spreadsheetId: LOFT_SHEET_ID,
                range,
                valueInputOption: "USER_ENTERED",
                requestBody: { values: [[newIndiv]] },
              });
            }
          }
        }

        // reverse old customer points
        const oldCustomerId = oldBillRows[0][BILL_COLUMNS.CUSTOMER_ID];
        if (oldCustomerId) {
          const custRes = await gsapi.spreadsheets.values.get({
            spreadsheetId: STORE_SHEET_ID,
            range: "Customers!A:I",
          });
          const custRows = custRes.data.values || [];
          const custIdx = custRows.findIndex((r) => r[CUSTOMER_COLUMNS.ID] === oldCustomerId);
          if (custIdx !== -1) {
            const row = custRows[custIdx];
            const oldSpend = Number(row[CUSTOMER_COLUMNS.EXPENDITURE]) || 0;
            const oldBills = Number(row[CUSTOMER_COLUMNS.TOTAL_BILLS]) || 0;
            const oldPoints = Number(row[CUSTOMER_COLUMNS.POINTS]) || 0;
            const oldFinalTotal = Number(oldBillRows[0][BILL_COLUMNS.FINAL_TOTAL]) || 0;
            const oldPointsEarned = Math.floor(oldFinalTotal * earnRate);
            await gsapi.spreadsheets.values.update({
              spreadsheetId: STORE_SHEET_ID,
              range: `Customers!G${custIdx + 2}:I${custIdx + 2}`,
              valueInputOption: "USER_ENTERED",
              requestBody: {
                values: [[oldSpend - oldFinalTotal, oldBills - 1, oldPoints - oldPointsEarned]],
              },
            });
          }
        }

        // delete old bill rows
        const sheetMeta = await gsapi.spreadsheets.get({
          spreadsheetId: STORE_SHEET_ID,
          fields: "sheets.properties(sheetId,title)",
        });
        const billSheetObj = (sheetMeta.data.sheets || []).find((s: any) => s.properties?.title === "Bill");
        if (billSheetObj) {
          const sheetId = billSheetObj.properties?.sheetId;
          if (sheetId && typeof sheetId === "number") {
            const sortedIndexes = [...oldRowIndexes].sort((a, b) => b - a);
            const requests = sortedIndexes.map((idx) => ({
              deleteDimension: {
                range: {
                  sheetId,
                  dimension: "ROWS",
                  startIndex: idx - 1,
                  endIndex: idx,
                },
              },
            }));
            await gsapi.spreadsheets.batchUpdate({
              spreadsheetId: STORE_SHEET_ID,
              requestBody: { requests },
            });
          }
        }

        // validate new items stock
        const stockInfos = [];
        for (const it of items) {
          const storeInfo = await getStoreStock(gsapi, it.item, it.shade);
          let loftInfo = null;
          if (!it.misc) loftInfo = await findLoftStockEntry(gsapi, it.item, it.shade);
          const storeAvailable = storeInfo.rowIndex !== -1 ? storeInfo.stock : 0;
          const loftAvailable = loftInfo ? loftInfo.individuals + loftInfo.packets * loftInfo.packetSize : 0;
          if (storeAvailable + loftAvailable < it.qty) {
            return res.status(400).json({ error: `insufficient stock for ${it.item} ${it.shade}` });
          }
          stockInfos.push({ ...it, storeInfo, loftInfo });
        }

        // deduct new stock
        const fallbackUsage = [];
        for (const info of stockInfos) {
          if (info.misc) continue;
          let remaining = info.qty;
          let usedStore = 0;
          if (info.storeInfo.rowIndex !== -1 && info.storeInfo.stock > 0) {
            usedStore = await deductStoreStock(gsapi, info.item, info.shade, info.storeInfo.rowIndex, info.storeInfo.stock, remaining, timestamp);
            remaining -= usedStore;
          }
          if (remaining > 0 && info.loftInfo) {
            const loftDetails = await deductLoftStock(gsapi, info.loftInfo, remaining);
            fallbackUsage.push({
              item: info.item,
              shade: info.shade,
              individualsUsed: loftDetails.individualsUsed,
              packetsOpened: loftDetails.packetsOpened,
            });
            await logLoftFallback(
              gsapi,
              originalBillNo,
              info.item,
              info.shade,
              remaining,
              loftDetails.individualsUsed,
              loftDetails.packetsOpened,
              loftDetails.leftoverBalls,
              info.loftInfo.packetSize,
              timestamp
            );
          }
        }

        // upsert customer
        const newCustomerId = await upsertCustomer(gsapi, customer, originalDate, finalTotal, earnRate);

        // write new bill rows
        const costMap = await getCostMap(gsapi);
        await ensureBillSheetColumns(gsapi);
        const newRows = [];
        for (const it of items) {
          const { total, profit } = calculateItemProfit(it, costMap);
          newRows.push(
            createBillRow(
              originalBillNo,
              it,
              profit,
              total,
              courierCharges,
              gpayCharges,
              finalTotal,
              newCustomerId,
              originalDate,
              originalTime,
              timestamp,
              paymentMode
            )
          );
        }
        await gsapi.spreadsheets.values.append({
          spreadsheetId: STORE_SHEET_ID,
          range: "Bill!A:O",
          valueInputOption: "USER_ENTERED",
          requestBody: { values: newRows },
        });
        return res.status(200).json({ success: true, billNo: originalBillNo, fallbackUsage });
      }

      // new bill
      const {
        items,
        finalTotal = 0,
        courierCharges = 0,
        paymentMode = "cash",
        gpayCharges = null,
        customer,
        earnRate = 0,
      } = req.body;

      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: "items must be a non-empty array" });
      }
      if (!customer || typeof customer !== "object" || !customer.phone) {
        return res.status(400).json({ error: "customer object with phone is required" });
      }
      const phoneDigits = customer.phone.replace(/[^0-9]/g, "");
      if (phoneDigits.length < 10) {
        return res.status(400).json({ error: "customer phone must have at least 10 digits" });
      }
      if (customer.type === "courier" && courierCharges <= 0) {
        return res.status(400).json({ error: "courier charges required for courier orders" });
      }

      const { date, time } = getISTDateTime();
      const timestamp = `${date} ${time}`;
      const billNo = await getNextBillNo(gsapi);

      // validate stock
      const stockInfos = [];
      for (const it of items) {
        const storeInfo = await getStoreStock(gsapi, it.item, it.shade);
        let loftInfo = null;
        if (!it.misc) loftInfo = await findLoftStockEntry(gsapi, it.item, it.shade);
        const storeAvailable = storeInfo.rowIndex !== -1 ? storeInfo.stock : 0;
        const loftAvailable = loftInfo ? loftInfo.individuals + loftInfo.packets * loftInfo.packetSize : 0;
        if (storeAvailable + loftAvailable < it.qty) {
          return res.status(400).json({ error: `insufficient stock for ${it.item} ${it.shade}` });
        }
        stockInfos.push({ ...it, storeInfo, loftInfo });
      }

      // deduct stock with rollback
      const fallbackUsage = [];
      const deductedStore = [];
      const deductedLoft = [];
      try {
        for (const info of stockInfos) {
          if (info.misc) continue;
          let remaining = info.qty;
          let usedStore = 0;
          if (info.storeInfo.rowIndex !== -1 && info.storeInfo.stock > 0) {
            usedStore = await deductStoreStock(gsapi, info.item, info.shade, info.storeInfo.rowIndex, info.storeInfo.stock, remaining, timestamp);
            remaining -= usedStore;
            deductedStore.push({ info, usedStore });
          }
          if (remaining > 0 && info.loftInfo) {
            const loftDetails = await deductLoftStock(gsapi, info.loftInfo, remaining);
            fallbackUsage.push({
              item: info.item,
              shade: info.shade,
              individualsUsed: loftDetails.individualsUsed,
              packetsOpened: loftDetails.packetsOpened,
            });
            deductedLoft.push({ info, loftDetails });
            await logLoftFallback(
              gsapi,
              billNo,
              info.item,
              info.shade,
              remaining,
              loftDetails.individualsUsed,
              loftDetails.packetsOpened,
              loftDetails.leftoverBalls,
              info.loftInfo.packetSize,
              timestamp
            );
          }
        }
      } catch (err) {
        // rollback store
        for (const { info, usedStore } of deductedStore) {
          const newStock = info.storeInfo.stock + usedStore;
          await gsapi.spreadsheets.values.update({
            spreadsheetId: STORE_SHEET_ID,
            range: `${escapeSheetName(info.item)}!C${info.storeInfo.rowIndex + 2}`,
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [[newStock]] },
          });
        }
        // rollback loft
        for (const { info, loftDetails } of deductedLoft) {
          const loftEntry = info.loftInfo;
          const newIndiv = loftEntry.individuals + loftDetails.leftoverBalls;
          const newPackets = loftEntry.packets + loftDetails.packetsOpened;
          const range = `${escapeSheetName(loftEntry.sheetName)}!E${loftEntry.rowIndex + 2}:F${loftEntry.rowIndex + 2}`;
          await gsapi.spreadsheets.values.update({
            spreadsheetId: LOFT_SHEET_ID,
            range,
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [[newIndiv, newPackets]] },
          });
        }
        return res.status(500).json({ error: "stock deduction failed, rolled back" });
      }

      // upsert customer
      let customerId;
      try {
        customerId = await upsertCustomer(gsapi, customer, date, finalTotal, earnRate);
      } catch (err: any) {
        // rollback stock again
        for (const { info, usedStore } of deductedStore) {
          const newStock = info.storeInfo.stock + usedStore;
          await gsapi.spreadsheets.values.update({
            spreadsheetId: STORE_SHEET_ID,
            range: `${escapeSheetName(info.item)}!C${info.storeInfo.rowIndex + 2}`,
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [[newStock]] },
          });
        }
        for (const { info, loftDetails } of deductedLoft) {
          const loftEntry = info.loftInfo;
          const newIndiv = loftEntry.individuals + loftDetails.leftoverBalls;
          const newPackets = loftEntry.packets + loftDetails.packetsOpened;
          const range = `${escapeSheetName(loftEntry.sheetName)}!E${loftEntry.rowIndex + 2}:F${loftEntry.rowIndex + 2}`;
          await gsapi.spreadsheets.values.update({
            spreadsheetId: LOFT_SHEET_ID,
            range,
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [[newIndiv, newPackets]] },
          });
        }
        return res.status(500).json({ error: `customer creation failed: ${err.message}` });
      }

      // write bill rows
      const costMap = await getCostMap(gsapi);
      await ensureBillSheetColumns(gsapi);
      const billRows = [];
      for (const it of items) {
        const { total, profit } = calculateItemProfit(it, costMap);
        billRows.push(
          createBillRow(
            billNo,
            it,
            profit,
            total,
            courierCharges,
            gpayCharges,
            finalTotal,
            customerId,
            date,
            time,
            timestamp,
            paymentMode
          )
        );
      }
      await gsapi.spreadsheets.values.append({
        spreadsheetId: STORE_SHEET_ID,
        range: "Bill!A:O",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: billRows },
      });
      return res.status(200).json({ billNo, customerId, fallbackUsage });
    }

    res.status(405).json({ error: "method not allowed" });
  } catch (err: any) {
    console.error("[handler_error]", err);
    res.status(500).json({ error: err.message || "failed to process bill" });
  }
}