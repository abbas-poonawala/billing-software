// api/bill.ts
import { google } from "googleapis";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// constants
const BILLS_SHEET = "Bills";
const BILL_ITEMS_SHEET = "BillItems";
const POINTS_CONFIG_SHEET = "PointsConfig";

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

function getISTDateTime() {
  const now = new Date();
  const date = now.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
  const time = now.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });
  return { date, time };
}

function escapeSheetName(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

function normaliseString(str: string | null | undefined): string {
  if (!str) return "";
  return str.toString().trim().replace(/\s+/g, " ").toLowerCase();
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

let storeSheetNamesCache: Set<string> | null = null;
let storeSheetNamesCacheTime = 0;

let loftSheetNamesCache: Set<string> | null = null;
let loftSheetNamesCacheTime = 0;

const CACHE_TTL_MS = 5 * 60 * 1000;

async function getStoreSheetNames(gsapi: any): Promise<Set<string>> {
  if (storeSheetNamesCache && Date.now() - storeSheetNamesCacheTime < CACHE_TTL_MS) {
    return storeSheetNamesCache;
  }
  const res = await gsapi.spreadsheets.get({
    spreadsheetId: STORE_SHEET_ID,
    fields: "sheets.properties.title",
  });
  const sheets = res.data.sheets || [];
  const names = new Set<string>();
  for (const s of sheets) names.add(s.properties?.title || "");
  storeSheetNamesCache = names;
  storeSheetNamesCacheTime = Date.now();
  return names;
}

async function getLoftSheetNames(gsapi: any): Promise<Set<string>> {
  if (loftSheetNamesCache && Date.now() - loftSheetNamesCacheTime < CACHE_TTL_MS) {
    return loftSheetNamesCache;
  }
  const res = await gsapi.spreadsheets.get({
    spreadsheetId: LOFT_SHEET_ID,
    fields: "sheets.properties.title",
  });
  const sheets = res.data.sheets || [];
  const names = new Set<string>();
  for (const s of sheets) names.add(s.properties?.title || "");
  loftSheetNamesCache = names;
  loftSheetNamesCacheTime = Date.now();
  return names;
}

function findMatchingSheetName(sheetSet: Set<string>, name: string): string | null {
  const normName = normaliseString(name);
  for (const sheet of sheetSet) {
    if (normaliseString(sheet) === normName) return sheet;
  }
  return null;
}

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

async function getPointsConfig(gsapi: any): Promise<{
  earnRate: number;
  spendBonuses: Array<{ spend: number; points: number }>;
  billBonuses: Array<{ bills: number; points: number }>;
}> {
  const res = await gsapi.spreadsheets.values.get({
    spreadsheetId: STORE_SHEET_ID,
    range: `${POINTS_CONFIG_SHEET}!A2:C`,
  });
  const rows = res.data.values || [];
  let earnRate = 0.01;
  const spendBonuses: Array<{ spend: number; points: number }> = [];
  const billBonuses: Array<{ bills: number; points: number }> = [];

  for (const row of rows) {
    const type = normaliseString(row[0]);
    if (type === "earn_rate") {
      earnRate = Number(row[1]) || 0.01;
    } else if (type === "spend_bonus") {
      spendBonuses.push({ spend: Number(row[1]) || 0, points: Number(row[2]) || 0 });
    } else if (type === "bill_bonus") {
      billBonuses.push({ bills: Number(row[1]) || 0, points: Number(row[2]) || 0 });
    }
  }

  return { earnRate, spendBonuses, billBonuses };
}

function calculatePointsEarned(
  spend: number,
  currentTotalBills: number,
  config: {
    earnRate: number;
    spendBonuses: Array<{ spend: number; points: number }>;
    billBonuses: Array<{ bills: number; points: number }>;
  }
): number {
  let points = spend * config.earnRate;
  for (const bonus of config.spendBonuses) {
    if (spend >= bonus.spend) points += bonus.points;
  }
  const newBillCount = currentTotalBills + 1;
  for (const bonus of config.billBonuses) {
    if (newBillCount >= bonus.bills) points += bonus.points;
  }
  return points;
}

async function upsertCustomer(
  gsapi: any,
  customer: any,
  date: string,
  finalTotal: number
): Promise<string> {
  const phoneNormalised = normalisePhone(customer.phone);
  if (!phoneNormalised) throw new Error("Valid customer phone required");

  const config = await getPointsConfig(gsapi);
  const existing = await findCustomerByPhone(gsapi, customer.phone);

  if (!existing) {
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

async function batchGetStoreStock(gsapi: any, items: Array<{ item: string; shade: string }>, existingSheets: Set<string>) {
  const result = new Map();
  const itemsBySheet = new Map<string, Array<{ idx: number; shade: string }>>();
  for (let i = 0; i < items.length; i++) {
    const sheet = items[i].item;
    const matchedSheetName = findMatchingSheetName(existingSheets, sheet) || sheet;
    if (!itemsBySheet.has(matchedSheetName)) itemsBySheet.set(matchedSheetName, []);
    itemsBySheet.get(matchedSheetName)!.push({ idx: i, shade: items[i].shade });
  }
  const ranges: string[] = [];
  const sheetOrder: string[] = [];
  for (const sheet of itemsBySheet.keys()) {
    if (findMatchingSheetName(existingSheets, sheet)) {
      ranges.push(`${escapeSheetName(sheet)}!B2:C`);
      sheetOrder.push(sheet);
    }
  }
  if (ranges.length === 0) return result;
  const batchRes = await gsapi.spreadsheets.values.batchGet({
    spreadsheetId: STORE_SHEET_ID,
    ranges,
  });
  const valueRanges = batchRes.data.valueRanges || [];
  for (let i = 0; i < valueRanges.length; i++) {
    const sheet = sheetOrder[i];
    const rows = valueRanges[i].values || [];
    const shadeMap = new Map();
    for (let r = 0; r < rows.length; r++) {
      const shade = normaliseString(rows[r][0]);
      if (shade) shadeMap.set(shade, { stock: Number(rows[r][1]) || 0, rowIndex: r });
    }
    for (const { idx, shade } of itemsBySheet.get(sheet)!) {
      const key = `${normaliseString(items[idx].item)}|${normaliseString(shade)}`;
      const found = shadeMap.get(normaliseString(shade));
      result.set(key, found || { stock: 0, rowIndex: -1 });
    }
  }
  return result;
}

async function batchGetLoftStock(gsapi: any, items: Array<{ item: string; shade: string }>, existingSheets: Set<string>, packetSizeMap: Map<string, number>) {
  const result = new Map();
  const itemsBySheet = new Map<string, Array<{ idx: number; shade: string }>>();
  for (let i = 0; i < items.length; i++) {
    const sheet = items[i].item;
    const matchedSheetName = findMatchingSheetName(existingSheets, sheet) || sheet;
    if (!itemsBySheet.has(matchedSheetName)) itemsBySheet.set(matchedSheetName, []);
    itemsBySheet.get(matchedSheetName)!.push({ idx: i, shade: items[i].shade });
  }
  const ranges: string[] = [];
  const sheetOrder: string[] = [];
  for (const sheet of itemsBySheet.keys()) {
    if (findMatchingSheetName(existingSheets, sheet)) {
      ranges.push(`${escapeSheetName(sheet)}!A2:L`);
      sheetOrder.push(sheet);
    }
  }
  if (ranges.length) {
    try {
      const batchRes = await gsapi.spreadsheets.values.batchGet({
        spreadsheetId: LOFT_SHEET_ID,
        ranges,
      });
      const valueRanges = batchRes.data.valueRanges || [];
      for (let i = 0; i < valueRanges.length; i++) {
        const sheet = sheetOrder[i];
        const rows = valueRanges[i].values || [];
        const shadeMap = new Map();
        for (let r = 0; r < rows.length; r++) {
          const shade = normaliseString(rows[r][0]);
          if (shade) {
            shadeMap.set(shade, {
              individuals: Number(rows[r][4]) || 0,
              packets: Number(rows[r][5]) || 0,
              rowIndex: r,
            });
          }
        }
        for (const { idx, shade } of itemsBySheet.get(sheet)!) {
          const key = `${normaliseString(items[idx].item)}|${normaliseString(shade)}`;
          const found = shadeMap.get(normaliseString(shade));
          if (found) {
            const packetSize = packetSizeMap.get(normaliseString(items[idx].item)) || 5;
            result.set(key, { ...found, packetSize, sheetName: sheet, isMisc: false });
          }
        }
      }
    } catch (err) {
      console.error(`[batchGetLoftStock] main batch failed`, err);
    }
  }
  
  const missingItems: Array<{ idx: number; item: string; shade: string }> = [];
  for (let i = 0; i < items.length; i++) {
    const key = `${normaliseString(items[i].item)}|${normaliseString(items[i].shade)}`;
    if (!result.has(key)) missingItems.push({ idx: i, item: items[i].item, shade: items[i].shade });
  }
  
  if (missingItems.length) {
    try {
      const miscRes = await gsapi.spreadsheets.values.get({
        spreadsheetId: LOFT_SHEET_ID,
        range: "miscellaneous!A2:L",
      });
      const miscRows = miscRes.data.values || [];
      for (const mi of missingItems) {
        const targetItem = normaliseString(mi.item);
        const targetShade = normaliseString(mi.shade);
        for (let r = 0; r < miscRows.length; r++) {
          const miscItem = normaliseString(miscRows[r][0]);
          const miscShade = normaliseString(miscRows[r][1]);
          if (miscItem === targetItem && miscShade === targetShade) {
            const individuals = Number(miscRows[r][4]) || 0;
            const packets = Number(miscRows[r][5]) || 0;
            const packetSize = packetSizeMap.get(targetItem) || 5;
            result.set(`${normaliseString(mi.item)}|${targetShade}`, { 
              individuals, 
              packets, 
              packetSize, 
              sheetName: "miscellaneous", 
              rowIndex: r, 
              isMisc: true 
            });
            break;
          }
        }
      }
    } catch (err) {
      console.error(`[batchGetLoftStock] misc read failed`, err);
    }
  }
  return result;
}

async function preloadPacketSizeMap(gsapi: any): Promise<Map<string, number>> {
  const res = await gsapi.spreadsheets.values.get({
    spreadsheetId: LOFT_SHEET_ID,
    range: "Settings!A2:B",
  });
  const rows = res.data.values || [];
  const map = new Map<string, number>();
  for (const r of rows) {
    const keyword = normaliseString(r[0]);
    if (keyword) map.set(keyword, Number(r[1]) || 5);
  }
  return map;
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
    return { 
      individualsUsed, 
      packetsOpened, 
      leftoverBalls, 
      newIndiv, 
      newPackets,
      originalIndividuals: individuals,
      originalPackets: packets
    };
  } else {
    const range = `${escapeSheetName(sheetName)}!E${rowIndex + 2}`;
    await gsapi.spreadsheets.values.update({
      spreadsheetId: LOFT_SHEET_ID,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[newIndiv]] },
    });
    return { 
      individualsUsed,
      packetsOpened: 0, 
      leftoverBalls: 0, 
      newIndiv, 
      newPackets: packets,
      originalIndividuals: individuals,
      originalPackets: packets
    };
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

async function getCostMap(gsapi: any): Promise<Map<string, number>> {
  const profitRes = await gsapi.spreadsheets.values.get({
    spreadsheetId: STORE_SHEET_ID,
    range: "Profit!A2:C",
  });
  const rows = profitRes.data.values || [];
  const costMap = new Map<string, number>();
  for (const row of rows) {
    const item = normaliseString(row[0]);
    const shade = normaliseString(row[1]);
    const cost = Number(row[2]) || 0;
    if (item) {
      const key = shade ? `${item}|${shade}` : `${item}|`;
      costMap.set(key, cost);
    }
  }
  return costMap;
}

async function getBillByNumber(gsapi: any, billNo: number): Promise<{ summary: any; items: any[] } | null> {
  const batchRes = await gsapi.spreadsheets.values.batchGet({
    spreadsheetId: STORE_SHEET_ID,
    ranges: [`${BILLS_SHEET}!A:J`, `${BILL_ITEMS_SHEET}!A:G`],
  });
  const billsRows = batchRes.data.valueRanges[0]?.values || [];
  const itemsRows = batchRes.data.valueRanges[1]?.values || [];
  const summaryRow = billsRows.find((row: any) => Number(row[BILLS_COLUMNS.BILL_NO]) === billNo);
  if (!summaryRow) return null;
  const itemRows = itemsRows.filter((row: any) => Number(row[BILL_ITEMS_COLUMNS.BILL_NO]) === billNo);
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

async function deleteBillRows(gsapi: any, billNo: number) {
  const sheetMeta = await gsapi.spreadsheets.get({
    spreadsheetId: STORE_SHEET_ID,
    fields: "sheets.properties(sheetId,title)",
  });
  const billsSheetObj = (sheetMeta.data.sheets || []).find((s: any) => s.properties?.title === BILLS_SHEET);
  const itemsSheetObj = (sheetMeta.data.sheets || []).find((s: any) => s.properties?.title === BILL_ITEMS_SHEET);
  if (!billsSheetObj || !itemsSheetObj) return;
  const batchRes = await gsapi.spreadsheets.values.batchGet({
    spreadsheetId: STORE_SHEET_ID,
    ranges: [`${BILLS_SHEET}!A:J`, `${BILL_ITEMS_SHEET}!A:G`],
  });
  const billsRows = batchRes.data.valueRanges[0]?.values || [];
  const itemsRows = batchRes.data.valueRanges[1]?.values || [];
  const billRowIndices: number[] = [];
  for (let i = 0; i < billsRows.length; i++) {
    if (Number(billsRows[i][BILLS_COLUMNS.BILL_NO]) === billNo) billRowIndices.push(i);
  }
  const itemRowIndices: number[] = [];
  for (let i = 0; i < itemsRows.length; i++) {
    if (Number(itemsRows[i][BILL_ITEMS_COLUMNS.BILL_NO]) === billNo) itemRowIndices.push(i);
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

function calculateItemProfit(item: any, costMap: Map<string, number>): { total: number; profit: number } {
  const qty = Number(item.qty) || 0;
  const price = Number(item.price) || 0;
  const total = qty * price;
  const itemKey = `${normaliseString(item.item)}|${normaliseString(item.shade)}`;
  let costPrice = costMap.get(itemKey) || 0;
  if (costPrice === 0) {
    const fallbackKey = `${normaliseString(item.item)}|`;
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const client = await auth.getClient();
    const gsapi = google.sheets({ version: "v4", auth: client as any });

    if (req.method === "GET") {
      const action = req.query.action as string;
      if (action === "getBill") {
        const billNo = Number(req.query.billNo);
        if (!billNo || billNo <= 0) return res.status(400).json({ error: "invalid bill number" });
        const billData = await getBillByNumber(gsapi, billNo);
        if (!billData) return res.status(404).json({ error: "bill not found" });
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
      const billsRes = await gsapi.spreadsheets.values.get({
        spreadsheetId: STORE_SHEET_ID,
        range: `${BILLS_SHEET}!A:A`,
      });
      const existingBills = (billsRes.data.values || []).flat().map(Number).filter((n) => !isNaN(n));
      const lastBillNo = existingBills.length > 0 ? Math.max(...existingBills) : 0;
      return res.status(200).json({ billNo: lastBillNo });
    }

    if (req.method === "POST") {
      const { action } = req.query;
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
        if (!items || !Array.isArray(items)) return res.status(400).json({ error: "items must be an array" });
        if (!customer || !customer.phone) return res.status(400).json({ error: "customer with phone is required" });
        const { date, time } = getISTDateTime();
        const timestamp = `${date} ${time}`;
        const oldBillData = await getBillByNumber(gsapi, originalBillNo);
        if (!oldBillData) return res.status(404).json({ error: "original bill not found" });
        const oldItems = oldBillData.items;
        const oldSummary = oldBillData.summary;
        const fallbackLog = await getLoftFallbackLogForBill(gsapi, originalBillNo);
        for (const item of oldItems) {
          const itemName = item.item;
          const shadeName = item.shade;
          const qty = item.qty;
          if (!itemName || !shadeName || qty === 0) continue;
          const storeSheetNames = await getStoreSheetNames(gsapi);
          const matchedStoreSheet = findMatchingSheetName(storeSheetNames, itemName);
          if (matchedStoreSheet) {
            const storeRes = await gsapi.spreadsheets.values.get({
              spreadsheetId: STORE_SHEET_ID,
              range: `${escapeSheetName(matchedStoreSheet)}!B2:C`,
            });
            const rows = storeRes.data.values || [];
            const targetShade = normaliseString(shadeName);
            let storeRowIndex = -1;
            let storeStock = 0;
            for (let r = 0; r < rows.length; r++) {
              if (normaliseString(rows[r][0]) === targetShade) {
                storeStock = Number(rows[r][1]) || 0;
                storeRowIndex = r;
                break;
              }
            }
            if (storeRowIndex !== -1) {
              await gsapi.spreadsheets.values.update({
                spreadsheetId: STORE_SHEET_ID,
                range: `${escapeSheetName(matchedStoreSheet)}!C${storeRowIndex + 2}`,
                valueInputOption: "USER_ENTERED",
                requestBody: { values: [[storeStock + qty]] },
              });
            }
          }
          const logEntry = fallbackLog.find(
            (log: any) => normaliseString(log[2]) === normaliseString(itemName) &&
              normaliseString(log[3]) === normaliseString(shadeName)
          );
          const loftSheetNames = await getLoftSheetNames(gsapi);
          const matchedLoftSheet = findMatchingSheetName(loftSheetNames, itemName);
          if (logEntry) {
            const individualsUsed = Number(logEntry[5]) || 0;
            const packetsOpened = Number(logEntry[6]) || 0;
            const leftoverBalls = Number(logEntry[7]) || 0;
            if (matchedLoftSheet) {
              const loftRes = await gsapi.spreadsheets.values.get({
                spreadsheetId: LOFT_SHEET_ID,
                range: `${escapeSheetName(matchedLoftSheet)}!A2:L`,
              });
              const rows = loftRes.data.values || [];
              const targetShade = normaliseString(shadeName);
              for (let r = 0; r < rows.length; r++) {
                if (normaliseString(rows[r][0]) === targetShade) {
                  const individuals = Number(rows[r][4]) || 0;
                  const packets = Number(rows[r][5]) || 0;
                  await gsapi.spreadsheets.values.update({
                    spreadsheetId: LOFT_SHEET_ID,
                    range: `${escapeSheetName(matchedLoftSheet)}!E${r + 2}:F${r + 2}`,
                    valueInputOption: "USER_ENTERED",
                    requestBody: { values: [[individuals + leftoverBalls, packets + packetsOpened]] },
                  });
                  break;
                }
              }
            }
          } else {
            if (matchedLoftSheet) {
              const loftRes = await gsapi.spreadsheets.values.get({
                spreadsheetId: LOFT_SHEET_ID,
                range: `${escapeSheetName(matchedLoftSheet)}!A2:L`,
              });
              const rows = loftRes.data.values || [];
              const targetShade = normaliseString(shadeName);
              for (let r = 0; r < rows.length; r++) {
                if (normaliseString(rows[r][0]) === targetShade) {
                  const individuals = Number(rows[r][4]) || 0;
                  await gsapi.spreadsheets.values.update({
                    spreadsheetId: LOFT_SHEET_ID,
                    range: `${escapeSheetName(matchedLoftSheet)}!E${r + 2}`,
                    valueInputOption: "USER_ENTERED",
                    requestBody: { values: [[individuals + qty]] },
                  });
                  break;
                }
              }
            } else {
              const miscRes = await gsapi.spreadsheets.values.get({
                spreadsheetId: LOFT_SHEET_ID,
                range: "miscellaneous!A2:L",
              });
              const miscRows = miscRes.data.values || [];
              for (let r = 0; r < miscRows.length; r++) {
                if (normaliseString(miscRows[r][0]) === normaliseString(itemName) &&
                    normaliseString(miscRows[r][1]) === normaliseString(shadeName)) {
                  const individuals = Number(miscRows[r][4]) || 0;
                  await gsapi.spreadsheets.values.update({
                    spreadsheetId: LOFT_SHEET_ID,
                    range: `miscellaneous!E${r + 2}`,
                    valueInputOption: "USER_ENTERED",
                    requestBody: { values: [[individuals + qty]] },
                  });
                  break;
                }
              }
            }
          }
        }
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
            const config = await getPointsConfig(gsapi);
            const oldPointsEarned = calculatePointsEarned(oldSummary.finalTotal, oldBills - 1, config);
            await gsapi.spreadsheets.values.update({
              spreadsheetId: STORE_SHEET_ID,
              range: `Customers!G${custIdx + 2}:I${custIdx + 2}`,
              valueInputOption: "USER_ENTERED",
              requestBody: {
                values: [[oldSpend - oldSummary.finalTotal, oldBills - 1, oldPoints - oldPointsEarned]],
              },
            });
          }
        }
        await deleteBillRows(gsapi, originalBillNo);
        const storeSheetNames = await getStoreSheetNames(gsapi);
        const loftSheetNames = await getLoftSheetNames(gsapi);
        const packetSizeMap = await preloadPacketSizeMap(gsapi);
        const storeStockMap = await batchGetStoreStock(gsapi, items, storeSheetNames);
        const loftStockMap = await batchGetLoftStock(gsapi, items, loftSheetNames, packetSizeMap);
        const stockInfos = [];
        for (const it of items) {
          const key = `${normaliseString(it.item)}|${normaliseString(it.shade)}`;
          const storeInfo = storeStockMap.get(key) || { stock: 0, rowIndex: -1 };
          const loftEntry = loftStockMap.get(key);
          const storeAvailable = storeInfo.stock;
          const loftAvailable = loftEntry
            ? ((Number(loftEntry.individuals) || 0) + (Number(loftEntry.packets) || 0) * (Number(loftEntry.packetSize) || 0))
            : 0;
          if (storeAvailable + loftAvailable < it.qty) {
            return res.status(400).json({ error: `insufficient stock for ${it.item} ${it.shade}` });
          }
          stockInfos.push({ ...it, storeInfo, loftInfo: loftEntry });
        }
        const fallbackUsage = [];
        const deductedStore = [];
        const deductedLoft = [];
        try {
          for (const info of stockInfos) {
            if (info.misc) continue;
            let remaining = info.qty;
            let usedStore = 0;
            const matchedStoreSheet = findMatchingSheetName(storeSheetNames, info.item) || info.item;
            if (info.storeInfo.rowIndex !== -1 && info.storeInfo.stock > 0) {
              usedStore = await deductStoreStock(gsapi, matchedStoreSheet, info.shade, info.storeInfo.rowIndex, info.storeInfo.stock, remaining, timestamp);
              remaining -= usedStore;
              deductedStore.push({ info, matchedStoreSheet, usedStore, originalStock: info.storeInfo.stock });
            }
            if (remaining > 0 && info.loftInfo && info.loftInfo.rowIndex !== -1) {
              const loftDetails = await deductLoftStock(gsapi, info.loftInfo, remaining);
              fallbackUsage.push({
                item: info.item,
                shade: info.shade,
                individualsUsed: loftDetails.individualsUsed,
                packetsOpened: loftDetails.packetsOpened,
              });
              deductedLoft.push({ info, loftDetails });
              await logLoftFallback(gsapi, originalBillNo, info.item, info.shade, remaining,
                loftDetails.individualsUsed, loftDetails.packetsOpened, loftDetails.leftoverBalls, info.loftInfo.packetSize, timestamp);
            }
          }
        } catch (err) {
          for (const { info, matchedStoreSheet, originalStock } of deductedStore) {
            await gsapi.spreadsheets.values.update({
              spreadsheetId: STORE_SHEET_ID,
              range: `${escapeSheetName(matchedStoreSheet)}!C${info.storeInfo.rowIndex + 2}`,
              valueInputOption: "USER_ENTERED",
              requestBody: { values: [[originalStock]] },
            });
          }
          for (const { info, loftDetails } of deductedLoft) {
            const loftEntry = info.loftInfo;
            await gsapi.spreadsheets.values.update({
              spreadsheetId: LOFT_SHEET_ID,
              range: `${escapeSheetName(loftEntry.sheetName)}!E${loftEntry.rowIndex + 2}:F${loftEntry.rowIndex + 2}`,
              valueInputOption: "USER_ENTERED",
              requestBody: { values: [[loftDetails.originalIndividuals, loftDetails.originalPackets]] },
            });
          }
          return res.status(500).json({ error: "stock deduction failed, rolled back" });
        }
        let customerId;
        try {
          customerId = await upsertCustomer(gsapi, customer, originalDate, finalTotal);
        } catch (err: any) {
          for (const { info, matchedStoreSheet, originalStock } of deductedStore) {
            await gsapi.spreadsheets.values.update({
              spreadsheetId: STORE_SHEET_ID,
              range: `${escapeSheetName(matchedStoreSheet)}!C${info.storeInfo.rowIndex + 2}`,
              valueInputOption: "USER_ENTERED",
              requestBody: { values: [[originalStock]] },
            });
          }
          for (const { info, loftDetails } of deductedLoft) {
            const loftEntry = info.loftInfo;
            await gsapi.spreadsheets.values.update({
              spreadsheetId: LOFT_SHEET_ID,
              range: `${escapeSheetName(loftEntry.sheetName)}!E${loftEntry.rowIndex + 2}:F${loftEntry.rowIndex + 2}`,
              valueInputOption: "USER_ENTERED",
              requestBody: { values: [[loftDetails.originalIndividuals, loftDetails.originalPackets]] },
            });
          }
          return res.status(500).json({ error: `customer creation failed: ${err.message}` });
        }
        const costMap = await getCostMap(gsapi);
        let totalProfit = 0;
        const itemRows = [];
        for (const it of items) {
          const { total, profit } = calculateItemProfit(it, costMap);
          totalProfit += profit;
          itemRows.push(createBillItemRow(originalBillNo, it, profit, total));
        }
        const summaryRow = createBillSummaryRow(originalBillNo, customerId, originalDate, originalTime,
          paymentMode, courierCharges, gpayCharges, finalTotal, totalProfit, timestamp);
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
      const { items, finalTotal = 0, courierCharges = 0, paymentMode = "cash", gpayCharges = null, customer } = req.body;
      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: "items must be a non-empty array" });
      }
      if (!customer || typeof customer !== "object" || !customer.phone) {
        return res.status(400).json({ error: "customer object with phone is required" });
      }
      const phoneDigits = customer.phone.replace(/[^0-9]/g, "");
      if (phoneDigits.length < 10) return res.status(400).json({ error: "customer phone must have at least 10 digits" });
      if (customer.type === "courier" && courierCharges <= 0) {
        return res.status(400).json({ error: "courier charges required for courier orders" });
      }
      const { date, time } = getISTDateTime();
      const timestamp = `${date} ${time}`;
      const billNo = await getNextBillNo(gsapi);
      const storeSheetNames = await getStoreSheetNames(gsapi);
      const loftSheetNames = await getLoftSheetNames(gsapi);
      const packetSizeMap = await preloadPacketSizeMap(gsapi);
      const storeStockMap = await batchGetStoreStock(gsapi, items, storeSheetNames);
      const loftStockMap = await batchGetLoftStock(gsapi, items, loftSheetNames, packetSizeMap);
      const costMap = await getCostMap(gsapi);
      const stockInfos = [];
      for (const it of items) {
        const key = `${normaliseString(it.item)}|${normaliseString(it.shade)}`;
        const storeInfo = storeStockMap.get(key) || { stock: 0, rowIndex: -1 };
        const loftEntry = loftStockMap.get(key);
        const storeAvailable = storeInfo.stock;
        const loftAvailable = loftEntry
          ? ((Number(loftEntry.individuals) || 0) + (Number(loftEntry.packets) || 0) * (Number(loftEntry.packetSize) || 0))
          : 0;
        if (storeAvailable + loftAvailable < it.qty) {
          return res.status(400).json({ error: `insufficient stock for ${it.item} ${it.shade}` });
        }
        stockInfos.push({ ...it, storeInfo, loftInfo: loftEntry });
      }
      const fallbackUsage = [];
      const deductedStore = [];
      const deductedLoft = [];
      try {
        for (const info of stockInfos) {
          if (info.misc) continue;
          let remaining = info.qty;
          let usedStore = 0;
          const matchedStoreSheet = findMatchingSheetName(storeSheetNames, info.item) || info.item;
          if (info.storeInfo.rowIndex !== -1 && info.storeInfo.stock > 0) {
            usedStore = await deductStoreStock(gsapi, matchedStoreSheet, info.shade, info.storeInfo.rowIndex, info.storeInfo.stock, remaining, timestamp);
            remaining -= usedStore;
            deductedStore.push({ info, matchedStoreSheet, usedStore, originalStock: info.storeInfo.stock });
          }
          if (remaining > 0 && info.loftInfo && info.loftInfo.rowIndex !== -1) {
            const loftDetails = await deductLoftStock(gsapi, info.loftInfo, remaining);
            fallbackUsage.push({
              item: info.item,
              shade: info.shade,
              individualsUsed: loftDetails.individualsUsed,
              packetsOpened: loftDetails.packetsOpened,
            });
            deductedLoft.push({ info, loftDetails });
            await logLoftFallback(gsapi, billNo, info.item, info.shade, remaining,
              loftDetails.individualsUsed, loftDetails.packetsOpened, loftDetails.leftoverBalls, info.loftInfo.packetSize, timestamp);
          }
        }
      } catch (err) {
        for (const { info, matchedStoreSheet, originalStock } of deductedStore) {
          await gsapi.spreadsheets.values.update({
            spreadsheetId: STORE_SHEET_ID,
            range: `${escapeSheetName(matchedStoreSheet)}!C${info.storeInfo.rowIndex + 2}`,
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [[originalStock]] },
          });
        }
        for (const { info, loftDetails } of deductedLoft) {
          const loftEntry = info.loftInfo;
          await gsapi.spreadsheets.values.update({
            spreadsheetId: LOFT_SHEET_ID,
            range: `${escapeSheetName(loftEntry.sheetName)}!E${loftEntry.rowIndex + 2}:F${loftEntry.rowIndex + 2}`,
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [[loftDetails.originalIndividuals, loftDetails.originalPackets]] },
          });
        }
        return res.status(500).json({ error: "stock deduction failed, rolled back" });
      }
      let customerId;
      try {
        customerId = await upsertCustomer(gsapi, customer, date, finalTotal);
      } catch (err: any) {
        for (const { info, matchedStoreSheet, originalStock } of deductedStore) {
          await gsapi.spreadsheets.values.update({
            spreadsheetId: STORE_SHEET_ID,
            range: `${escapeSheetName(matchedStoreSheet)}!C${info.storeInfo.rowIndex + 2}`,
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [[originalStock]] },
          });
        }
        for (const { info, loftDetails } of deductedLoft) {
          const loftEntry = info.loftInfo;
          await gsapi.spreadsheets.values.update({
            spreadsheetId: LOFT_SHEET_ID,
            range: `${escapeSheetName(loftEntry.sheetName)}!E${loftEntry.rowIndex + 2}:F${loftEntry.rowIndex + 2}`,
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [[loftDetails.originalIndividuals, loftDetails.originalPackets]] },
          });
        }
        return res.status(500).json({ error: `customer creation failed: ${err.message}` });
      }
      let totalProfit = 0;
      const itemRows = [];
      for (const it of items) {
        const { total, profit } = calculateItemProfit(it, costMap);
        totalProfit += profit;
        itemRows.push(createBillItemRow(billNo, it, profit, total));
      }
      const summaryRow = createBillSummaryRow(billNo, customerId, date, time, paymentMode,
        courierCharges, gpayCharges, finalTotal, totalProfit, timestamp);
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