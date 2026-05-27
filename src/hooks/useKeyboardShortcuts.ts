import { useEffect } from "react";
import { useBillingStore } from "../store/billingStore";
import { isValidPhone } from "../utils/phone";

interface Handlers {
  onSaveBill: () => void;
  onSaveBillAndSend: () => void;
}

export function useKeyboardShortcuts(handlers: Handlers) {
  const { items, phone, saving, selectedRow, setSelectedRow } = useBillingStore();

  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName || "";
      const isTypingField = tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable;
      const phoneValid = isValidPhone(phone);

      // only true global shortcuts live here
      if (e.ctrlKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (phoneValid && items.length > 0 && !saving) handlers.onSaveBill();
        return;
      }

      if (e.ctrlKey && e.key === "Enter") {
        e.preventDefault();
        if (phoneValid && items.length > 0 && !saving) handlers.onSaveBillAndSend();
        return;
      }

      if (isTypingField) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedRow(selectedRow === null ? 0 : Math.min(selectedRow + 1, items.length - 1));
        return;
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedRow(selectedRow === null ? 0 : Math.max(selectedRow - 1, 0));
        return;
      }

      if (e.key === "Escape") {
        setSelectedRow(null);
      }
    };

    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [items.length, phone, saving, selectedRow, handlers, setSelectedRow]);
}
