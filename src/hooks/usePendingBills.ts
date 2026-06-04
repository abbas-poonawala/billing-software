/**
 * usePendingBills — Draft Bill / POS Recovery System (BUG-11 fix)
 *
 * Responsibilities:
 * 1. Generate a client-side UUID for each bill before attempting to save.
 * 2. Persist draft to localStorage so bills survive page refreshes.
 * 3. Track save attempts, errors, and status transitions.
 * 4. Expose a list of pending/failed bills for the PendingBillsPanel.
 * 5. Preserve the reserved bill number across retry attempts.
 */

import { useState, useCallback, useEffect } from "react";
import type { DraftBill, DraftBillStatus, BillItem, Customer, CustomerType, PaymentMode } from "../types";

const PENDING_BILLS_KEY = "pendingBills_v1";
const MAX_SAVED_TO_SHOW = 10; // Keep last N saved bills for audit trail

function generateId(): string {
  return `draft_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function now(): string {
  return new Date().toISOString();
}

function loadFromStorage(): DraftBill[] {
  try {
    const raw = localStorage.getItem(PENDING_BILLS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as DraftBill[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveToStorage(bills: DraftBill[]): void {
  try {
    // Trim saved bills — only keep recent SAVED ones for audit, all non-SAVED ones
    const nonSaved = bills.filter(b => b.status !== "SAVED");
    const saved = bills
      .filter(b => b.status === "SAVED")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MAX_SAVED_TO_SHOW);
    localStorage.setItem(PENDING_BILLS_KEY, JSON.stringify([...nonSaved, ...saved]));
  } catch (e) {
    console.error("Failed to persist pending bills:", e);
  }
}

export interface CreateDraftParams {
  items: BillItem[];
  customerName: string;
  customerId: string;
  phone: string;
  phone2: string;
  redeemPoints: boolean;
  courierCharges: string;
  customerType: CustomerType;
  paymentMode: PaymentMode;
  customer: Customer | null;
  reservedBillNo: number | null;
}

export function usePendingBills() {
  const [bills, setBills] = useState<DraftBill[]>(() => loadFromStorage());

  // Persist on every change
  useEffect(() => {
    saveToStorage(bills);
  }, [bills]);

  const updateBills = useCallback((updater: (prev: DraftBill[]) => DraftBill[]) => {
    setBills(prev => {
      const next = updater(prev);
      return next;
    });
  }, []);

  /** Create a new DRAFT bill and return its draftId */
  const createDraft = useCallback((params: CreateDraftParams): string => {
    const draftId = generateId();
    const draft: DraftBill = {
      draftId,
      status: "DRAFT",
      reservedBillNo: params.reservedBillNo,
      createdAt: now(),
      updatedAt: now(),
      saveAttempts: 0,
      ...params,
    };
    updateBills(prev => [draft, ...prev]);
    return draftId;
  }, [updateBills]);

  /** Update draft fields (e.g., when user edits before saving) */
  const updateDraft = useCallback((draftId: string, patch: Partial<DraftBill>) => {
    updateBills(prev =>
      prev.map(b => b.draftId === draftId
        ? { ...b, ...patch, updatedAt: now() }
        : b
      )
    );
  }, [updateBills]);

  /** Mark bill as PENDING_SAVE (save in-flight) */
  const markPendingSave = useCallback((
    draftId: string,
    finalTotal: number,
    gpayCharges: number | null,
    courierChargesNum: number
  ) => {
    updateBills(prev =>
      prev.map(b => b.draftId === draftId
        ? {
            ...b,
            status: "PENDING_SAVE" as DraftBillStatus,
            saveAttempts: b.saveAttempts + 1,
            finalTotal,
            gpayCharges,
            courierChargesNum,
            updatedAt: now(),
          }
        : b
      )
    );
  }, [updateBills]);

  /** Mark bill as SAVED after successful API response */
  const markSaved = useCallback((draftId: string, confirmedBillNo: number) => {
    updateBills(prev =>
      prev.map(b => b.draftId === draftId
        ? {
            ...b,
            status: "SAVED" as DraftBillStatus,
            reservedBillNo: confirmedBillNo,
            lastError: undefined,
            updatedAt: now(),
          }
        : b
      )
    );
  }, [updateBills]);

  /** Mark save as failed — stays as PENDING_SAVE so user can retry */
  const markSaveFailed = useCallback((draftId: string, error: string) => {
    updateBills(prev =>
      prev.map(b => b.draftId === draftId
        ? {
            ...b,
            status: "PENDING_SAVE" as DraftBillStatus,
            lastError: error,
            updatedAt: now(),
          }
        : b
      )
    );
  }, [updateBills]);

  /** Delete a draft (user explicitly discards it) */
  const deleteDraft = useCallback((draftId: string) => {
    updateBills(prev => prev.filter(b => b.draftId !== draftId));
  }, [updateBills]);

  /** Get a single draft by ID */
  const getDraft = useCallback((draftId: string): DraftBill | undefined => {
    return bills.find(b => b.draftId === draftId);
  }, [bills]);

  /** All bills that need attention (DRAFT or failed PENDING_SAVE) */
  const pendingBills = bills.filter(b => b.status === "DRAFT" || b.status === "PENDING_SAVE");

  /** Count for badge display */
  const pendingCount = pendingBills.length;

  return {
    bills,
    pendingBills,
    pendingCount,
    createDraft,
    updateDraft,
    markPendingSave,
    markSaved,
    markSaveFailed,
    deleteDraft,
    getDraft,
  };
}