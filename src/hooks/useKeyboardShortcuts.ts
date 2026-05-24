/**
 * useKeyboardShortcuts
 * ────────────────────
 * Centralizes all keyboard logic. Previously scattered throughout App.tsx.
 *
 * Shortcuts:
 *  Ctrl+S        → save bill
 *  Ctrl+Enter    → save & send WhatsApp
 *  Arrow Up/Down → navigate bill table rows (when not in input)
 *  Escape        → deselect row
 *  Enter         → context-aware: add item / move focus / accept suggestion
 *  Tab           → accept fuzzy suggestion
 */

import { useEffect } from "react";
import { useBillingStore } from "../store/billingStore";
import { isValidPhone } from "../utils/phone";

interface Refs {
  itemRef: React.RefObject<HTMLInputElement | null>;
  shadeRef: React.RefObject<HTMLInputElement | null>;
  qtyRef: React.RefObject<HTMLInputElement | null>;
  priceRef: React.RefObject<HTMLInputElement | null>;
  barcodeRef: React.RefObject<HTMLInputElement | null>;
}

interface Handlers {
  onAddItem: () => void;
  onSaveBill: () => void;
  onSaveBillAndSend: () => void;
  onBarcodeSubmit: () => void;
  onAcceptItemSuggestion: () => void;
  onAcceptShadeSuggestion: () => void;
  hasItemSuggestion: boolean;
  hasShadeSuggestion: boolean;
  isStandard: boolean;
}

export function useKeyboardShortcuts(refs: Refs, handlers: Handlers) {
  const { items, phone, saving, setSelectedRow, entryItem, entryShade, entryPrice } = useBillingStore();
  const { itemRef, shadeRef, qtyRef, priceRef, barcodeRef } = refs;
  const fields = [itemRef, shadeRef, qtyRef, priceRef];

  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const tag = target.tagName;
      const isInput = tag === "INPUT" || tag === "TEXTAREA";
      const phoneValid = isValidPhone(phone);

      // ── Global shortcuts ───────────────────────────────────────────────
      if (e.ctrlKey && e.key === "s") {
        e.preventDefault();
        if (phoneValid && items.length > 0 && !saving) handlers.onSaveBill();
        return;
      }
      if (e.ctrlKey && e.key === "Enter") {
        e.preventDefault();
        if (phoneValid && items.length > 0 && !saving) handlers.onSaveBillAndSend();
        return;
      }

      // ── Row navigation (when not in input) ────────────────────────────
      if (!isInput) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelectedRow(prev => (prev === null ? 0 : Math.min(prev + 1, items.length - 1)));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelectedRow(prev => (prev === null ? 0 : Math.max(prev - 1, 0)));
          return;
        }
      }

      if (e.key === "Escape") {
        setSelectedRow(null);
        return;
      }

      // ── Input-specific navigation ──────────────────────────────────────
      if (isInput) {
        if (e.key === "ArrowRight") {
          const idx = fields.findIndex(r => r.current === target);
          if (idx !== -1 && idx < fields.length - 1) {
            e.preventDefault();
            fields[idx + 1].current?.focus();
          }
          return;
        }
        if (e.key === "ArrowLeft") {
          const idx = fields.findIndex(r => r.current === target);
          if (idx > 0) {
            e.preventDefault();
            fields[idx - 1].current?.focus();
          }
          return;
        }
      }

      // ── Barcode input ─────────────────────────────────────────────────
      if (target === barcodeRef.current) {
        if ((e.key === "Enter" || e.key === "Tab") && target === barcodeRef.current) {
          e.preventDefault();
          handlers.onBarcodeSubmit();
          return;
        }
      }

      // ── Tab: accept suggestion ────────────────────────────────────────
      if (e.key === "Tab") {
        if (target === itemRef.current && handlers.hasItemSuggestion) {
          e.preventDefault();
          handlers.onAcceptItemSuggestion();
          return;
        }
        if (target === shadeRef.current && handlers.hasShadeSuggestion) {
          e.preventDefault();
          handlers.onAcceptShadeSuggestion();
          return;
        }
      }

      // ── Enter: context-aware action ───────────────────────────────────
      if (e.key !== "Enter") return;

      if (target === itemRef.current) {
        e.preventDefault();
        if (handlers.hasItemSuggestion) {
          handlers.onAcceptItemSuggestion();
        } else if (entryItem) {
          handlers.isStandard ? qtyRef.current?.focus() : shadeRef.current?.focus();
        }
        return;
      }

      if (target === shadeRef.current) {
        e.preventDefault();
        if (handlers.hasShadeSuggestion) {
          handlers.onAcceptShadeSuggestion();
        } else if (entryShade) {
          qtyRef.current?.focus();
        }
        return;
      }

      if (target === qtyRef.current) {
        e.preventDefault();
        priceRef.current?.focus();
        return;
      }

      if (target === priceRef.current && entryItem && entryShade && entryPrice) {
        e.preventDefault();
        handlers.onAddItem();
        return;
      }

      // Fallback: if on a non-button element and form looks complete
      if (tag !== "BUTTON" && entryItem && entryShade && entryPrice) {
        e.preventDefault();
        handlers.onAddItem();
      }
    };

    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [items, phone, saving, entryItem, entryShade, entryPrice, handlers.hasItemSuggestion, handlers.hasShadeSuggestion, handlers.isStandard]);
}
