"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * Count active AI handoffs that still need human triage: the bot is paused,
 * left a handoff summary, nobody owns the conversation, and it is not closed.
 */
export function usePendingAiHandoffs(accountId?: string | null): number {
    const [snapshot, setSnapshot] = useState({
        accountId: null as string | null,
        count: 0,
    });

    useEffect(() => {
        if (!accountId) return;

        const supabase = createClient();
        let cancelled = false;

        const refresh = async () => {
            const { count: pendingCount, error } = await supabase
                .from("conversations")
                .select("id", { count: "exact", head: true })
                .eq("account_id", accountId)
                .eq("ai_autoreply_disabled", true)
                .in("status", ["open", "pending"])
                .is("assigned_agent_id", null)
                .not("ai_handoff_summary", "is", null);

            if (!cancelled && !error) {
                setSnapshot({ accountId, count: pendingCount ?? 0 });
            }
        };

        void refresh();

        const channel = supabase
            .channel(`pending-ai-handoffs:${accountId}`)
            .on(
                "postgres_changes",
                {
                    event: "*",
                    schema: "public",
                    table: "conversations",
                    filter: `account_id=eq.${accountId}`,
                },
                () => void refresh(),
            )
            .subscribe();

        return () => {
            cancelled = true;
            supabase.removeChannel(channel);
        };
    }, [accountId]);

    return snapshot.accountId === accountId ? snapshot.count : 0;
}