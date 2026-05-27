/**
 * Shared API types and error definitions
 * Provides strong typing for all API interactions
 */

// Auth
export interface AuthContext {
  userId: string;
  role: "cashier" | "admin" | "inventory";
  timestamp: number;
}

// Error responses - structured, versioned
export class APIError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: Record<string, any>
  ) {
    super(message);
    this.name = "APIError";
  }
}

export const ErrorCodes = {
  // Auth
  MISSING_AUTH: "MISSING_AUTH",
  INVALID_TOKEN: "INVALID_TOKEN",
  INSUFFICIENT_ROLE: "INSUFFICIENT_ROLE",
  
  // Validation
  INVALID_REQUEST: "INVALID_REQUEST",
  MISSING_PARAM: "MISSING_PARAM",
  
  // Inventory
  INSUFFICIENT_STOCK: "INSUFFICIENT_STOCK",
  STOCK_CHANGED: "STOCK_CHANGED", // optimistic lock failure
  CONCURRENT_MUTATION: "CONCURRENT_MUTATION",
  
  // Bill
  DUPLICATE_BILL_NO: "DUPLICATE_BILL_NO",
  BILL_NOT_FOUND: "BILL_NOT_FOUND",
  INVALID_BILL_STATE: "INVALID_BILL_STATE",
  
  // Customer
  DUPLICATE_CUSTOMER: "DUPLICATE_CUSTOMER",
  CUSTOMER_NOT_FOUND: "CUSTOMER_NOT_FOUND",
  
  // Sheet operations
  SHEET_OPERATION_FAILED: "SHEET_OPERATION_FAILED",
  SHEET_QUOTA_EXCEEDED: "SHEET_QUOTA_EXCEEDED",
  
  // General
  INTERNAL_ERROR: "INTERNAL_ERROR",
};

// Request/Response payloads
export interface BillSaveRequest {
  items: Array<{
    item: string;
    shade: string;
    qty: number;
    cost: number;
    price: number;
    total: number;
    profit: number;
    misc?: boolean;
  }>;
  finalTotal: number;
  courierCharges: number;
  gpayCharges: number | null;
  paymentMode: "Cash" | "GPay";
  customer: {
    name: string;
    phone: string;
    phone2: string;
    type: "walk-in" | "courier";
    courier: boolean;
  };
  earnRate: number;
  redeemRate: number;
  // For edits:
  originalBillNo?: number;
  originalDate?: string;
  originalTime?: string;
  originalRowIndexes?: number[];
  // Version tracking (optimistic locking)
  version?: string;
}

export interface BillSaveResponse {
  billNo: number;
  customerId: string;
  fallbackUsage?: Array<{
    item: string;
    shade: string;
    individualsUsed: number;
    packetsOpened: number;
  }>;
  version?: string;
}

// Inventory transaction log (for rollback/audit)
export interface InventoryTransaction {
  id: string;
  billNo: number;
  timestamp: string;
  item: string;
  shade: string;
  operation: "deduct" | "restore";
  qty: number;
  storeChange: { before: number; after: number };
  loftChange?: { 
    individualsChange: number; 
    packetsChange: number;
  };
  status: "pending" | "committed" | "failed";
  errorMessage?: string;
}

// Optimistic lock version (stored in row metadata)
export interface RowVersion {
  billNo: number;
  rowIndex: number;
  hash: string; // SHA256 of {item|shade|qty|date|time}
  timestamp: string;
}
