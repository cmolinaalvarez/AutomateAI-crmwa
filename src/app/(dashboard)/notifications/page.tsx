"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import type { ConversationStatus, Notification } from "@/types";
import { Bell, CheckCheck, Loader2, UserPlus } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

// Icon per notification type. Only one type exists today
// (conversation_assigned) but this keeps future types a one-line add.
const TYPE_ICON: Record<Notification["type"], typeof Bell> = {
  conversation_assigned: UserPlus,
};

const AI_QUEUE_TITLE = "AI handoff needs assignment";
const STATUS_TABS = [
  { value: "open", labelKey: "tabOpen" },
  { value: "pending", labelKey: "tabPending" },
  { value: "closed", labelKey: "tabClosed" },
] as const satisfies ReadonlyArray<{
  value: ConversationStatus;
  labelKey: "tabOpen" | "tabPending" | "tabClosed";
}>;

export default function NotificationsPage() {
  const t = useTranslations("Notifications");
  const router = useRouter();
  const { accountId } = useAuth();
  const [notifications, setNotifications] = useState<Notification[] | null>(
    null,
  );
  const [conversationStatuses, setConversationStatuses] = useState<
    Record<string, ConversationStatus>
  >({});
  const [activeStatus, setActiveStatus] =
    useState<ConversationStatus>("open");
  const [error, setError] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);

  const load = useCallback(async () => {
    if (!accountId) return;
    const supabase = createClient();
    const { data, error: fetchErr } = await supabase
      .from("notifications")
      .select("*")
      .eq("account_id", accountId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (fetchErr) {
      setError(fetchErr.message);
      return;
    }
    const rows = (data ?? []) as Notification[];
    const conversationIds = [
      ...new Set(
        rows
          .map((notification) => notification.conversation_id)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const statuses: Record<string, ConversationStatus> = {};

    if (conversationIds.length > 0) {
      const { data: conversations, error: conversationsErr } = await supabase
        .from("conversations")
        .select("id, status")
        .in("id", conversationIds);
      if (conversationsErr) {
        setError(conversationsErr.message);
        return;
      }
      for (const conversation of conversations ?? []) {
        statuses[conversation.id] = conversation.status as ConversationStatus;
      }
    }

    setConversationStatuses(statuses);
    setNotifications(rows);
  }, [accountId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Realtime — new assignments appear without a refresh, and a
  // "mark all read" fired from another tab/device stays in sync here.
  useEffect(() => {
    if (!accountId) return;

    const supabase = createClient();
    const channel = supabase
      .channel(`notifications-page:${accountId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "notifications",
          filter: `account_id=eq.${accountId}`,
        },
        (payload) => {
          if (payload.eventType === "INSERT") {
            void load();
          } else if (payload.eventType === "UPDATE") {
            const row = payload.new as Notification;
            setNotifications((prev) =>
              prev?.map((n) => (n.id === row.id ? { ...n, ...row } : n)) ??
              prev,
            );
          } else if (payload.eventType === "DELETE") {
            void load();
          }
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "conversations",
          filter: `account_id=eq.${accountId}`,
        },
        (payload) => {
          const row = payload.new as {
            id: string;
            status: ConversationStatus;
          };
          setConversationStatuses((previous) =>
            row.id in previous
              ? { ...previous, [row.id]: row.status }
              : previous,
          );
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [accountId, load]);

  const markRead = useCallback(
    async (id: string) => {
      // Optimistic — the row is already visually "read" by the time the
      // request lands, so the UI doesn't wait on the round-trip.
      setNotifications(
        (prev) =>
          prev?.map((n) =>
            n.id === id && !n.read_at
              ? { ...n, read_at: new Date().toISOString() }
              : n,
          ) ?? prev,
      );
      const supabase = createClient();
      const { error: updateErr } = await supabase
        .from("notifications")
        .update({ read_at: new Date().toISOString() })
        .eq("id", id)
        .is("read_at", null);
      if (updateErr) {
        toast.error(t("markReadFailed"));
        load();
      }
    },
    [load, t],
  );

  const handleClick = useCallback(
    (n: Notification) => {
      if (!n.read_at) markRead(n.id);
      if (n.conversation_id) {
        router.push(`/inbox?c=${n.conversation_id}`);
      }
    },
    [markRead, router],
  );

  const unreadIds = notifications?.filter((n) => !n.read_at).map((n) => n.id) ?? [];

  // Assignment notifications are an event history, so repeatedly assigning
  // the same conversation can create several rows. This page is an operational
  // queue: represent each conversation once, using its newest notification.
  const latestNotifications = useMemo(() => {
    const seenConversationIds = new Set<string>();
    return (notifications ?? []).filter((notification) => {
      if (!notification.conversation_id) return false;
      if (seenConversationIds.has(notification.conversation_id)) return false;
      seenConversationIds.add(notification.conversation_id);
      return true;
    });
  }, [notifications]);

  const notificationsForStatus = (status: ConversationStatus) =>
    latestNotifications.filter(
      (notification) =>
        notification.conversation_id &&
        conversationStatuses[notification.conversation_id] === status,
    );

  const markAllRead = useCallback(async () => {
    if (unreadIds.length === 0) return;
    setMarkingAll(true);
    const now = new Date().toISOString();
    setNotifications(
      (prev) => prev?.map((n) => (n.read_at ? n : { ...n, read_at: now })) ?? prev,
    );
    const supabase = createClient();
    const { error: updateErr } = await supabase
      .from("notifications")
      .update({ read_at: now })
      .is("read_at", null);
    setMarkingAll(false);
    if (updateErr) {
      toast.error(t("markAllFailed"));
      load();
    }
  }, [unreadIds.length, load, t]);

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          {t("retry")}
        </Button>
      </div>
    );
  }

  if (notifications === null) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("description")}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={unreadIds.length === 0 || markingAll}
          onClick={markAllRead}
        >
          {markingAll ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <CheckCheck className="h-4 w-4" />
          )}
          {t("markAllRead")}
        </Button>
      </div>

      <Tabs
        value={activeStatus}
        onValueChange={(value) =>
          value && setActiveStatus(value as ConversationStatus)
        }
        className="gap-4"
      >
        <TabsList className="h-10 w-full justify-start overflow-x-auto bg-muted/60 p-1 sm:w-fit">
          {STATUS_TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value} className="gap-2 px-3">
              {t(tab.labelKey)}
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-background px-1.5 text-[10px] font-semibold tabular-nums text-muted-foreground">
                {notificationsForStatus(tab.value).length}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>

        {STATUS_TABS.map((tab) => {
          const statusNotifications = notificationsForStatus(tab.value);
          return (
            <TabsContent key={tab.value} value={tab.value}>
              {statusNotifications.length === 0 ? (
                <div className="flex h-48 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/40">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
                    <Bell className="h-6 w-6 text-primary" />
                  </div>
                  <p className="mt-3 text-sm font-medium text-foreground">
                    {t("emptyStatusTitle", { status: t(tab.labelKey).toLowerCase() })}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("emptyStatusDesc")}
                  </p>
                </div>
              ) : (
                <ul className="space-y-2">
                  {statusNotifications.map((n) => {
                    const Icon = TYPE_ICON[n.type] ?? Bell;
                    const isUnread = !n.read_at;
                    const isAiQueueHandoff = n.title === AI_QUEUE_TITLE;
                    return (
                      <li key={n.id}>
                        <button
                          type="button"
                          onClick={() => handleClick(n)}
                          className={cn(
                            "flex w-full items-start gap-3 rounded-xl border p-4 text-left transition-colors",
                            isUnread
                              ? "border-primary/30 bg-primary/5 hover:border-primary/50"
                              : "border-border bg-card hover:border-border/70",
                          )}
                        >
                          <div
                            className={cn(
                              "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
                              isUnread ? "bg-primary/15" : "bg-muted",
                            )}
                            aria-hidden
                          >
                            <Icon
                              className={cn(
                                "h-5 w-5",
                                isUnread ? "text-primary" : "text-muted-foreground",
                              )}
                            />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span
                                className={cn(
                                  "truncate text-sm font-semibold",
                                  isUnread ? "text-foreground" : "text-muted-foreground",
                                )}
                              >
                                {isAiQueueHandoff
                                  ? t("aiHandoffTitle")
                                  : t("assignmentTitle")}
                              </span>
                              {isUnread && (
                                <span
                                  aria-label={t("unread")}
                                  className="h-2 w-2 shrink-0 rounded-full bg-primary"
                                />
                              )}
                            </div>
                            {(isAiQueueHandoff ? n.body : t("assignmentCardBody")) && (
                              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                                {isAiQueueHandoff ? n.body : t("assignmentCardBody")}
                              </p>
                            )}
                            <p className="mt-1 text-[11px] text-muted-foreground/70">
                              {formatDistanceToNow(new Date(n.created_at), {
                                addSuffix: true,
                              })}
                            </p>
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </TabsContent>
          );
        })}
      </Tabs>
    </div>
  );
}
