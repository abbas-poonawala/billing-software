/**
 * Toast notification utilities
 * Centralized toast handling using Sonner
 * Replaces dual Zustand + Sonner state
 */

import { toast } from "sonner";

export type ToastType = "success" | "error" | "info";

/**
 * Show a toast notification
 * @param message The message to display
 * @param type The notification type (success, error, info)
 */
export function showToast(message: string, type: ToastType = "info"): void {
  switch (type) {
    case "success":
      toast.success(message);
      break;
    case "error":
      toast.error(message);
      break;
    case "info":
    default:
      toast.info(message);
      break;
  }
}

/**
 * Show an error toast (shorthand)
 */
export function showErrorToast(message: string): void {
  toast.error(message);
}

/**
 * Show a success toast (shorthand)
 */
export function showSuccessToast(message: string): void {
  toast.success(message);
}

/**
 * Show an info toast (shorthand)
 */
export function showInfoToast(message: string): void {
  toast.info(message);
}

/**
 * Dismiss all toasts
 */
export function dismissAllToasts(): void {
  toast.dismiss();
}
