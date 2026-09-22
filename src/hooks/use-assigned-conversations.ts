"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

/** Count open or pending conversations assigned to the signed-in user. */
export function useAssignedConversations(
    accountId?: string | null,
    userId?: string | null,
): number {
    const [snapshot, setSnapshot] = useState({
        accountId: null as string | null,
        userId: null as string | null,
        count: 0,
    });

    useEffect(() => {
        if (!accountId || !userId) return;

        const supabase = createClient();
        let cancelled = false;

        const refresh = async () => {
            const { count, error } = await supabase
                .from("conversations")
                .select("id", { count: "exact", head: true })
                .eq("account_id", accountId)
                .eq("assigned_agent_id", userId)
                .in("status", ["open", "pending"]);

            if (!cancelled && !error) {
                setSnapshot({ accountId, userId, count: count ?? 0 });
            }
        };

        void refresh();

        const channel = supabase
            .channel(`assigned-conversations:${accountId}:${userId}`)
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
    }, [accountId, userId]);

    return snapshot.accountId === accountId && snapshot.userId === userId
        ? snapshot.count
        : 0;
}