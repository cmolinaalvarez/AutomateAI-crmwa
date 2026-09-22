"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import type { Notification } from "@/types";

const AI_QUEUE_TITLE = "AI handoff needs assignment";

/** Shows an actionable in-app alert whenever this user receives an assignment. */
export function useRealtimeAssignmentAlerts(): void {
    const router = useRouter();
    const t = useTranslations("Notifications");

    useEffect(() => {
        const supabase = createClient();
        const openConversation = async (row: Notification) => {
            await supabase
                .from("notifications")
                .update({ read_at: new Date().toISOString() })
                .eq("id", row.id)
                .is("read_at", null);
            if (row.conversation_id) router.push(`/inbox?c=${row.conversation_id}`);
        };

        const channel = supabase
            .channel("realtime-assignment-alerts")
            .on(
                "postgres_changes",
                { event: "INSERT", schema: "public", table: "notifications" },
                (payload) => {
                    const row = payload.new as Notification;
                    const isAiQueueHandoff = row.title === AI_QUEUE_TITLE;
                    toast.info(
                        isAiQueueHandoff
                            ? t("aiHandoffToastTitle")
                            : t("assignmentToastTitle"),
                        {
                            description: isAiQueueHandoff
                                ? t("aiHandoffToastDesc")
                                : t("assignmentToastDesc"),
                            duration: 15_000,
                            action: row.conversation_id
                                ? {
                                    label: isAiQueueHandoff ? t("reviewNow") : t("attendNow"),
                                    onClick: () => void openConversation(row),
                                }
                                : undefined,
                        },
                    );
                },
            )
            .subscribe();

        return () => {
            supabase.removeChannel(channel);
        };
    }, [router, t]);
}