"use client";

import { useBrowserNotifications } from "@/hooks/use-browser-notifications";
import { useRealtimeAssignmentAlerts } from "@/hooks/use-realtime-assignment-alerts";

/**
 * Headless. Mount ONCE per signed-in dashboard tab (the dashboard
 * shell, below the auth gate) so desktop notifications for new customer
 * messages fire on every dashboard page, not just the inbox.
 */
export function BrowserNotificationsListener() {
  useBrowserNotifications();
  useRealtimeAssignmentAlerts();
  return null;
}
