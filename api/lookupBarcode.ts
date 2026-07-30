// api/lookupBarcode.ts
import { google } from "googleapis";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT!),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const STORE_SHEET_ID = process.env.SHEET_ID!;

function escapeSheetName(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { barcode } = req.query;
  if (!barcode || typeof barcode !== "string") {
    return res.status(400).json({ error: "Missing barcode parameter" });
  }

  try {
    const client = await auth.getClient();
    const gsapi = google.sheets({ version: "v4", auth: client as any });

    const sheetMeta = await gsapi.spreadsheets.get({
      spreadsheetId: STORE_SHEET_ID,
      fields: "sheets.properties.title",
    });
    const skipTabs = [
      "bill", "registry", "profit", "discount", "discounts", "customers",
      "pointslog", "pointsconfig", "restock requests", "loft fallback log"
    ];
    const itemTabs = (sheetMeta.data.sheets || [])
      .map((s: any) => s.properties?.title || "")
      .filter(name => name && !skipTabs.includes(name.toLowerCase()));

    for (const sheetName of itemTabs) {
      // Search columns A:D (barcode, shade, stock, price)
      const response = await gsapi.spreadsheets.values.get({
        spreadsheetId: STORE_SHEET_ID,
        range: `${escapeSheetName(sheetName)}!A2:D`,
      });
      const rows = response.data.values || [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const barcodeCell = row[0]?.toString().trim();
        if (barcodeCell === barcode) {
          const shade = row[1]?.toString().trim() || "";
          const stock = Number(row[2]) || 0;
          const price = Number(row[3]) || 0;
          return res.status(200).json({
            item: sheetName,
            shade: shade,
            price: price,
            stock: stock,
          });
        }
      }
    }

    return res.status(404).json({ error: "Product not found for this barcode" });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to lookup barcode" });
  }
}