type PointsConfigRow = {
  type: string;
  value1?: string | number | null;
  value2?: string | number | null;
};

export interface SharedPointsConfig {
  earnRate: number;
  redeemRate: number | null;
  minRedeem: number | null;
  spendBonus: Array<{ threshold: number; bonus: number }>;
  billBonus: Array<{ threshold: number; bonus: number }>;
}

function normaliseString(value: string | null | undefined): string {
  if (!value) return "";
  return value.toString().trim().toLowerCase();
}

export async function getSharedPointsConfig(gsapi: any, spreadsheetId: string): Promise<SharedPointsConfig> {
  const res = await gsapi.spreadsheets.values.get({
    spreadsheetId,
    range: "PointsConfig!A2:C",
  });

  const rows = (res.data.values || []) as Array<Array<string | undefined>>;
  const parsed: PointsConfigRow[] = rows
    .filter((row) => Array.isArray(row) && row.length > 0)
    .map((row) => ({
      type: row[0]?.toString() || "",
      value1: row[1],
      value2: row[2],
    }));

  const config: SharedPointsConfig = {
    earnRate: 0,
    redeemRate: null,
    minRedeem: null,
    spendBonus: [],
    billBonus: [],
  };

  for (const row of parsed) {
    const type = normaliseString(row.type);
    if (type === "earn_rate") {
      config.earnRate = Number(row.value1) || 0;
    } else if (type === "redeem_rate") {
      const value = Number(row.value1);
      config.redeemRate = Number.isFinite(value) ? value : null;
    } else if (type === "min_redeem") {
      const value = Number(row.value1);
      config.minRedeem = Number.isFinite(value) ? value : null;
    } else if (type === "spend_bonus") {
      const threshold = Number(row.value1);
      const bonus = Number(row.value2);
      if (Number.isFinite(threshold) && Number.isFinite(bonus)) {
        config.spendBonus.push({ threshold, bonus });
      }
    } else if (type === "bill_bonus") {
      const threshold = Number(row.value1);
      const bonus = Number(row.value2);
      if (Number.isFinite(threshold) && Number.isFinite(bonus)) {
        config.billBonus.push({ threshold, bonus });
      }
    }
  }

  return config;
}
