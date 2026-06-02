// api/bill.ts
import { google } from "googleapis";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// sheet names
const BILLS_SHEET = "Bills";
const BILL_ITEMS_SHEET = "BillItems";
const POINTS_CONFIG_SHEET = "PointsConfig";

// column indices
const BILLS_COLUMNS = {
  BILL_NO: 0,
  CUSTOMER_ID: 1,
  DATE: 2,
  TIME: 3,
  PAYMENT_MODE: 4,
  COURIER_CHARGES: 5,
  GPAY_CHARGES: 6,
  FINAL_TOTAL: 7,
  TOTAL_PROFIT: 8,
  LAST_UPDATED: 9,
} as const;

const BILL_ITEMS_COLUMNS = {
  BILL_NO: 0,
  ITEM: 1,
  SHADE: 2,
  QTY: 3,
  PRICE: 4,
  PROFIT: 5,
  TOTAL: 6,
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

// google auth
const auth = new google.auth.GoogleAuth({
  credentials: (() => {
    try {
      return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT!);
    } catch (err) {
      console.error("[init_error] failed to parse service account:", err);
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

// bill number
async function getNextBillNo(gsapi: any): Promise<number> {
  const existingRes = await gsapi.spreadsheets.values.get({
    spreadsheetId: STORE_SHEET_ID,
    range: `${BILLS_SHEET}!A:A`,
  });
  const existingBills = (existingRes.data.values || [])
    .flat()
    .map(Number)
    .filter((n: any) => !isNaN(n));
  const maxBillNo = existingBills.length > 0 ? Math.max(...existingBills) : 0;
  return maxBillNo + 1;
}

// customer
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

// points configuration
async function ensurePointsConfigSheet(gsapi: any) {
  const sheetMeta = await gsapi.spreadsheets.get({
    spreadsheetId: STORE_SHEET_ID,
    fields: "sheets.properties.title",
  });
  const sheetExists = (sheetMeta.data.sheets || []).some(
    (s: any) => s.properties?.title === POINTS_CONFIG_SHEET
  );
  if (!sheetExists) {
    await gsapi.spreadsheets.batchUpdate({
      spreadsheetId: STORE_SHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: POINTS_CONFIG_SHEET } } }],
      },
    });
    // default config
    const defaultConfig = [
      ["EarnRate", 0.01],
      ["RedeemRate", 0.5],
      ["MinRedeem", 50],
      ["SpendBonus", "2000:0.25,5000:0.5"],
      ["BillBonus", "5:1,10:1"],
    ];
    await gsapi.spreadsheets.values.update({
      spreadsheetId: STORE_SHEET_ID,
      range: `${POINTS_CONFIG_SHEET}!A1:B${defaultConfig.length}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: defaultConfig },
    });
  }
}

async function getPointsConfig(gsapi: any): Promise<{
  earnRate: number;
  redeemRate: number;
  minRedeem: number;
  spendBonuses: Array<{ spend: number; points: number }>;
  billBonuses: Array<{ bills: number; points: number }>;
}> {
  await ensurePointsConfigSheet(gsapi);
  const res = await gsapi.spreadsheets.values.get({
    spreadsheetId: STORE_SHEET_ID,
    range: `${POINTS_CONFIG_SHEET}!A:B`,
  });
  const rows = res.data.values || [];
  let earnRate = 0.01;
  let redeemRate = 0.5;
  let minRedeem = 50;
  let spendBonusStr = "";
  let billBonusStr = "";
  for (const row of rows) {
    const key = row[0]?.toString().toLowerCase();
    const val = row[1]?.toString();
    if (key === "earnrate") earnRate = parseFloat(val) || 0.01;
    if (key === "redeemrate") redeemRate = parseFloat(val) || 0.5;
    if (key === "minredeem") minRedeem = parseInt(val) || 50;
    if (key === "spendbonus") spendBonusStr = val || "";
    if (key === "billbonus") billBonusStr = val || "";
  }
  // parse spend bonuses e.g., "2000:0.25,5000:0.5"
  const spendBonuses: Array<{ spend: number; points: number }> = [];
  if (spendBonusStr) {
    spendBonusStr.split(",").forEach((item) => {
      const [spend, points] = item.split(":");
      if (spend && points) {
        spendBonuses.push({ spend: parseFloat(spend), points: parseFloat(points) });
      }
    });
  }
  // parse bill bonuses e.g., "5:1,10:1"
  const billBonuses: Array<{ bills: number; points: number }> = [];
  if (billBonusStr) {
    billBonusStr.split(",").forEach((item) => {
      const [bills, points] = item.split(":");
      if (bills && points) {
        billBonuses.push({ bills: parseInt(bills), points: parseFloat(points) });
      }
    });
  }
  return { earnRate, redeemRate, minRedeem, spendBonuses, billBonuses };
}

function calculatePointsEarned(
  spend: number,
  currentTotalBills: number,   // old bill count before this purchase
  config: {
    earnRate: number;
    spendBonuses: Array<{ spend: number; points: number }>;
    billBonuses: Array<{ bills: number; points: number }>;
  }
): number {
  // base points
  let points = Math.floor(spend) * config.earnRate;
  // spend bonuses (additive for all thresholds crossed)
  for (const bonus of config.spendBonuses) {
    if (spend >= bonus.spend) {
      points += bonus.points;
    }
  }
  // bill bonuses based on new bill count (current + 1)
  const newBillCount = currentTotalBills + 1;
  for (const bonus of config.billBonuses) {
    if (newBillCount >= bonus.bills) {
      points += bonus.points;
    }
  }
  return points;
}

// upsert customer with points config
async function upsertCustomer(
  gsapi: any,
  customer: any,
  date: string,
  finalTotal: number,
  _earnRateIgnored: number // kept for compatibility, not used
): Promise<string> {
  const phoneNormalised = normalisePhone(customer.phone);
  if (!phoneNormalised) throw new Error("Valid customer phone required");

  const config = await getPointsConfig(gsapi);
  const existing = await findCustomerByPhone(gsapi, customer.phone);

  if (!existing) {
    // new customer: no previous bills, currentTotalBills = 0
    const pointsEarned = calculatePointsEarned(finalTotal, 0, config);
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
  const pointsEarned = calculatePointsEarned(finalTotal, currentBills, config);
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

// stock and loft helpers
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

// sheet setup for bills 
async function ensureBillsSheet(gsapi: any) {
  const sheetMeta = await gsapi.spreadsheets.get({
    spreadsheetId: STORE_SHEET_ID,
    fields: "sheets.properties(title,sheetId,gridProperties)",
  });
  let billsSheet = (sheetMeta.data.sheets || []).find((s: any) => s.properties?.title === BILLS_SHEET);
  if (!billsSheet) {
    await gsapi.spreadsheets.batchUpdate({
      spreadsheetId: STORE_SHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: BILLS_SHEET } } }],
      },
    });
  }
  // ensure columns
  billsSheet = (await gsapi.spreadsheets.get({
    spreadsheetId: STORE_SHEET_ID,
    fields: "sheets.properties(title,sheetId,gridProperties)",
  })).data.sheets?.find((s: any) => s.properties?.title === BILLS_SHEET);
  const currentCols = billsSheet?.properties?.gridProperties?.columnCount || 0;
  const requiredCols = Object.keys(BILLS_COLUMNS).length;
  if (currentCols < requiredCols) {
    await gsapi.spreadsheets.batchUpdate({
      spreadsheetId: STORE_SHEET_ID,
      requestBody: {
        requests: [
          {
            updateSheetProperties: {
              properties: {
                sheetId: billsSheet.properties?.sheetId,
                gridProperties: { columnCount: requiredCols },
              },
              fields: "gridProperties.columnCount",
            },
          },
        ],
      },
    });
  }
  // set headers if missing
  const headers = [
    "bill no", "customer id", "date", "time", "payment mode",
    "courier charges", "gpay charges", "final total", "total profit", "last updated",
  ];
  const headerRange = await gsapi.spreadsheets.values.get({
    spreadsheetId: STORE_SHEET_ID,
    range: `${BILLS_SHEET}!A1:J1`,
  });
  if (!headerRange.data.values || headerRange.data.values.length === 0) {
    for (let i = 0; i < headers.length; i++) {
      await gsapi.spreadsheets.values.update({
        spreadsheetId: STORE_SHEET_ID,
        range: `${BILLS_SHEET}!${String.fromCharCode(65 + i)}1`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[headers[i]]] },
      });
    }
  }
}

async function ensureBillItemsSheet(gsapi: any) {
  const sheetMeta = await gsapi.spreadsheets.get({
    spreadsheetId: STORE_SHEET_ID,
    fields: "sheets.properties(title,sheetId,gridProperties)",
  });
  let itemsSheet = (sheetMeta.data.sheets || []).find((s: any) => s.properties?.title === BILL_ITEMS_SHEET);
  if (!itemsSheet) {
    await gsapi.spreadsheets.batchUpdate({
      spreadsheetId: STORE_SHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: BILL_ITEMS_SHEET } } }],
      },
    });
  }
  itemsSheet = (await gsapi.spreadsheets.get({
    spreadsheetId: STORE_SHEET_ID,
    fields: "sheets.properties(title,sheetId,gridProperties)",
  })).data.sheets?.find((s: any) => s.properties?.title === BILL_ITEMS_SHEET);
  const currentCols = itemsSheet?.properties?.gridProperties?.columnCount || 0;
  const requiredCols = Object.keys(BILL_ITEMS_COLUMNS).length;
  if (currentCols < requiredCols) {
    await gsapi.spreadsheets.batchUpdate({
      spreadsheetId: STORE_SHEET_ID,
      requestBody: {
        requests: [
          {
            updateSheetProperties: {
              properties: {
                sheetId: itemsSheet.properties?.sheetId,
                gridProperties: { columnCount: requiredCols },
              },
              fields: "gridProperties.columnCount",
            },
          },
        ],
      },
    });
  }
  const headers = ["bill no", "item", "shade / variant", "qty", "price", "profit", "total"];
  const headerRange = await gsapi.spreadsheets.values.get({
    spreadsheetId: STORE_SHEET_ID,
    range: `${BILL_ITEMS_SHEET}!A1:G1`,
  });
  if (!headerRange.data.values || headerRange.data.values.length === 0) {
    for (let i = 0; i < headers.length; i++) {
      await gsapi.spreadsheets.values.update({
        spreadsheetId: STORE_SHEET_ID,
        range: `${BILL_ITEMS_SHEET}!${String.fromCharCode(65 + i)}1`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[headers[i]]] },
      });
    }
  }
}

async function ensureSheets(gsapi: any) {
  await ensureBillsSheet(gsapi);
  await ensureBillItemsSheet(gsapi);
}

// profit and cost
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

function createBillItemRow(billNo: number, item: any, profit: number, total: number): any[] {
  return [billNo, item.item, item.shade, item.qty, item.price, profit, total];
}

function createBillSummaryRow(
  billNo: number,
  customerId: string,
  date: string,
  time: string,
  paymentMode: string,
  courierCharges: number,
  gpayCharges: number | null,
  finalTotal: number,
  totalProfit: number,
  lastUpdated: string
): any[] {
  return [
    billNo,
    customerId,
    date,
    time,
    paymentMode,
    courierCharges > 0 ? courierCharges : "",
    gpayCharges !== null ? gpayCharges : "",
    finalTotal,
    totalProfit,
    lastUpdated,
  ];
}

// get bill by number 
async function getBillByNumber(gsapi: any, billNo: number): Promise<{ summary: any; items: any[] } | null> {
  const billsRes = await gsapi.spreadsheets.values.get({
    spreadsheetId: STORE_SHEET_ID,
    range: `${BILLS_SHEET}!A:J`,
  });
  const allBills = billsRes.data.values || [];
  const summaryRow = allBills.find((row: any) => Number(row[BILLS_COLUMNS.BILL_NO]) === billNo);
  if (!summaryRow) return null;

  const itemsRes = await gsapi.spreadsheets.values.get({
    spreadsheetId: STORE_SHEET_ID,
    range: `${BILL_ITEMS_SHEET}!A:G`,
  });
  const allItems = itemsRes.data.values || [];
  const itemRows = allItems.filter((row: any) => Number(row[BILL_ITEMS_COLUMNS.BILL_NO]) === billNo);

  const items = itemRows.map((row: any) => ({
    item: row[BILL_ITEMS_COLUMNS.ITEM],
    shade: row[BILL_ITEMS_COLUMNS.SHADE],
    qty: Number(row[BILL_ITEMS_COLUMNS.QTY]) || 0,
    price: Number(row[BILL_ITEMS_COLUMNS.PRICE]) || 0,
    total: Number(row[BILL_ITEMS_COLUMNS.TOTAL]) || 0,
    profit: Number(row[BILL_ITEMS_COLUMNS.PROFIT]) || 0,
    cost: 0,
  }));

  return {
    summary: {
      billNo: Number(summaryRow[BILLS_COLUMNS.BILL_NO]),
      customerId: summaryRow[BILLS_COLUMNS.CUSTOMER_ID],
      date: summaryRow[BILLS_COLUMNS.DATE],
      time: summaryRow[BILLS_COLUMNS.TIME],
      paymentMode: summaryRow[BILLS_COLUMNS.PAYMENT_MODE] || "cash",
      courierCharges: Number(summaryRow[BILLS_COLUMNS.COURIER_CHARGES]) || 0,
      gpayCharges: summaryRow[BILLS_COLUMNS.GPAY_CHARGES] ? Number(summaryRow[BILLS_COLUMNS.GPAY_CHARGES]) : null,
      finalTotal: Number(summaryRow[BILLS_COLUMNS.FINAL_TOTAL]) || 0,
      totalProfit: Number(summaryRow[BILLS_COLUMNS.TOTAL_PROFIT]) || 0,
      lastUpdated: summaryRow[BILLS_COLUMNS.LAST_UPDATED],
    },
    items,
  };
}

// delete bill rows 
async function deleteBillRows(gsapi: any, billNo: number) {
  const sheetMeta = await gsapi.spreadsheets.get({
    spreadsheetId: STORE_SHEET_ID,
    fields: "sheets.properties(sheetId,title)",
  });
  const billsSheetObj = (sheetMeta.data.sheets || []).find((s: any) => s.properties?.title === BILLS_SHEET);
  const itemsSheetObj = (sheetMeta.data.sheets || []).find((s: any) => s.properties?.title === BILL_ITEMS_SHEET);
  if (!billsSheetObj || !itemsSheetObj) return;

  const billsRes = await gsapi.spreadsheets.values.get({
    spreadsheetId: STORE_SHEET_ID,
    range: `${BILLS_SHEET}!A:J`,
  });
  const billsRows = billsRes.data.values || [];
  const billRowIndices: number[] = [];
  for (let i = 0; i < billsRows.length; i++) {
    if (Number(billsRows[i][BILLS_COLUMNS.BILL_NO]) === billNo) {
      billRowIndices.push(i);
    }
  }

  const itemsRes = await gsapi.spreadsheets.values.get({
    spreadsheetId: STORE_SHEET_ID,
    range: `${BILL_ITEMS_SHEET}!A:G`,
  });
  const itemsRows = itemsRes.data.values || [];
  const itemRowIndices: number[] = [];
  for (let i = 0; i < itemsRows.length; i++) {
    if (Number(itemsRows[i][BILL_ITEMS_COLUMNS.BILL_NO]) === billNo) {
      itemRowIndices.push(i);
    }
  }

  const requests = [];
  for (const idx of billRowIndices.sort((a, b) => b - a)) {
    requests.push({
      deleteDimension: {
        range: {
          sheetId: billsSheetObj.properties?.sheetId,
          dimension: "ROWS",
          startIndex: idx,
          endIndex: idx + 1,
        },
      },
    });
  }
  for (const idx of itemRowIndices.sort((a, b) => b - a)) {
    requests.push({
      deleteDimension: {
        range: {
          sheetId: itemsSheetObj.properties?.sheetId,
          dimension: "ROWS",
          startIndex: idx,
          endIndex: idx + 1,
        },
      },
    });
  }
  if (requests.length > 0) {
    await gsapi.spreadsheets.batchUpdate({
      spreadsheetId: STORE_SHEET_ID,
      requestBody: { requests },
    });
  }
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
        const billData = await getBillByNumber(gsapi, billNo);
        if (!billData) {
          return res.status(404).json({ error: "bill not found" });
        }
        const { summary, items } = billData;

        let customerName = "unknown";
        let customerPhone = "";
        if (summary.customerId) {
          const custRes = await gsapi.spreadsheets.values.get({
            spreadsheetId: STORE_SHEET_ID,
            range: "Customers!A:C",
          });
          const custRows = custRes.data.values || [];
          const custRow = custRows.find((r: any) => r[0] === summary.customerId);
          if (custRow) {
            customerName = custRow[1] || "unknown";
            customerPhone = custRow[2] || "";
          }
        }

        return res.status(200).json({
          bill: {
            billNo: summary.billNo,
            items,
            customerId: summary.customerId,
            customerName,
            customerPhone,
            date: summary.date,
            time: summary.time,
            courierCharges: summary.courierCharges,
            paymentMode: summary.paymentMode,
            gpayCharges: summary.gpayCharges,
            finalTotal: summary.finalTotal,
            lastUpdated: summary.lastUpdated,
          },
        });
      }

      // get last bill number
      const billsRes = await gsapi.spreadsheets.values.get({
        spreadsheetId: STORE_SHEET_ID,
        range: `${BILLS_SHEET}!A:A`,
      });
      const existingBills = (billsRes.data.values || [])
        .flat()
        .map(Number)
        .filter((n) => !isNaN(n));
      const lastBillNo = existingBills.length > 0 ? Math.max(...existingBills) : 0;
      return res.status(200).json({ billNo: lastBillNo });
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

        const oldBillData = await getBillByNumber(gsapi, originalBillNo);
        if (!oldBillData) {
          return res.status(404).json({ error: "original bill not found" });
        }
        const oldItems = oldBillData.items;
        const oldSummary = oldBillData.summary;

        // reverse old stock
        const fallbackLog = await getLoftFallbackLogForBill(gsapi, originalBillNo);
        for (const item of oldItems) {
          const itemName = item.item;
          const shadeName = item.shade;
          const qty = item.qty;
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
              log[2]?.toString().trim().toLowerCase() === itemName.toLowerCase() &&
              log[3]?.toString().trim().toLowerCase() === shadeName.toLowerCase()
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
        const oldCustomerId = oldSummary.customerId;
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
            const oldFinalTotal = oldSummary.finalTotal;
            // we need the old points earned for this bill. Since we don't store it, we recalc with current config.
            const config = await getPointsConfig(gsapi);
            const oldPointsEarned = calculatePointsEarned(oldFinalTotal, oldBills - 1, config);
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
        await deleteBillRows(gsapi, originalBillNo);

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
        } catch (err) {
          // rollback
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
          return res.status(500).json({ error: "stock deduction failed, rolled back" });
        }

        // upsert customer (ignores earnRate parameter)
        let customerId;
        try {
          // pass dummy earnRate (0) – config will be read inside
          customerId = await upsertCustomer(gsapi, customer, originalDate, finalTotal, 0);
        } catch (err: any) {
          // rollback stock
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

        // write new bill rows
        const costMap = await getCostMap(gsapi);
        await ensureSheets(gsapi);

        let totalProfit = 0;
        const itemRows = [];
        for (const it of items) {
          const { total, profit } = calculateItemProfit(it, costMap);
          totalProfit += profit;
          itemRows.push(createBillItemRow(originalBillNo, it, profit, total));
        }

        const summaryRow = createBillSummaryRow(
          originalBillNo,
          customerId,
          originalDate,
          originalTime,
          paymentMode,
          courierCharges,
          gpayCharges,
          finalTotal,
          totalProfit,
          timestamp
        );

        await gsapi.spreadsheets.values.append({
          spreadsheetId: STORE_SHEET_ID,
          range: `${BILL_ITEMS_SHEET}!A:G`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: itemRows },
        });
        await gsapi.spreadsheets.values.append({
          spreadsheetId: STORE_SHEET_ID,
          range: `${BILLS_SHEET}!A:J`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [summaryRow] },
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

      // deduct stock
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
        // rollback
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
        return res.status(500).json({ error: "stock deduction failed, rolled back" });
      }

      // upsert customer (ignores earnRate)
      let customerId;
      try {
        customerId = await upsertCustomer(gsapi, customer, date, finalTotal, 0);
      } catch (err: any) {
        // rollback stock
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

      // write bill
      const costMap = await getCostMap(gsapi);
      await ensureSheets(gsapi);

      let totalProfit = 0;
      const itemRows = [];
      for (const it of items) {
        const { total, profit } = calculateItemProfit(it, costMap);
        totalProfit += profit;
        itemRows.push(createBillItemRow(billNo, it, profit, total));
      }

      const summaryRow = createBillSummaryRow(
        billNo,
        customerId,
        date,
        time,
        paymentMode,
        courierCharges,
        gpayCharges,
        finalTotal,
        totalProfit,
        timestamp
      );

      await gsapi.spreadsheets.values.append({
        spreadsheetId: STORE_SHEET_ID,
        range: `${BILL_ITEMS_SHEET}!A:G`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: itemRows },
      });
      await gsapi.spreadsheets.values.append({
        spreadsheetId: STORE_SHEET_ID,
        range: `${BILLS_SHEET}!A:J`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [summaryRow] },
      });

      return res.status(200).json({ billNo, customerId, fallbackUsage });
    }

    res.status(405).json({ error: "method not allowed" });
  } catch (err: any) {
    console.error("[handler_error]", err);
    res.status(500).json({ error: err.message || "failed to process bill" });
  }
}