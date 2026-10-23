import { useCallback, useEffect, useRef } from "react";
import { toast } from "@heroui/react";

interface NoticeAction {
  label: string;
  onPress: () => void;
}

/** Keep notifications scoped to this explorer and its current project. */
export function useBeagleNotifications() {
  const ids = useRef<{ error: string | undefined; notice: string | undefined }>({ error: undefined, notice: undefined });
  const active = useRef(true);
  const showError = useCallback((message?: string) => {
    if (ids.current.error) toast.close(ids.current.error);
    ids.current.error = message && active.current ? toast.danger(message, { timeout: 0 }) : undefined;
  }, []);
  const showNotice = useCallback((message?: string, action?: NoticeAction, variant: "success" | "accent" = "success") => {
    if (ids.current.notice) toast.close(ids.current.notice);
    ids.current.notice = undefined;
    if (!message || !active.current) return;
    const id = toast(message, {
      variant, timeout: action ? 8000 : 5000,
      ...(action ? { actionProps: { children: action.label, variant: "tertiary" as const, onPress: () => {
        toast.close(id);
        if (active.current && ids.current.notice === id) action.onPress();
      } } } : {}),
    });
    ids.current.notice = id;
  }, []);
  const clearNotifications = useCallback(() => { showError(); showNotice(); }, [showError, showNotice]);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; clearNotifications(); };
  }, [clearNotifications]);
  return { showError, showNotice, clearNotifications };
}
