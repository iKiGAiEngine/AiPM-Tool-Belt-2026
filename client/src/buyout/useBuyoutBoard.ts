// Board state + debounced auto-save. Every change to the board schedules a
// PATCH; the board (server JSONB) is the single source of truth on resume.

import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/queryClient";
import { useQueryClient } from "@tanstack/react-query";
import type { BuyoutBoard } from "@shared/buyout/types";

export type SaveState = "idle" | "saving" | "saved" | "error";

export function useBuyoutBoard(projectId: number, initial: BuyoutBoard) {
  const [board, setBoard] = useState<BuyoutBoard>(initial);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<BuyoutBoard | null>(null);
  const qc = useQueryClient();

  // Reset when switching projects.
  useEffect(() => {
    setBoard(initial);
    setSaveState("idle");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const flush = useCallback(async () => {
    if (!pending.current) return;
    const toSave = pending.current;
    pending.current = null;
    setSaveState("saving");
    try {
      await apiRequest("PATCH", `/api/buyout/projects/${projectId}`, { board: toSave });
      setSaveState("saved");
      qc.invalidateQueries({ queryKey: ["/api/buyout/projects"] });
    } catch {
      setSaveState("error");
    }
  }, [projectId, qc]);

  /** Apply an immutable mutation to the board and schedule a save. */
  const update = useCallback(
    (mutator: (draft: BuyoutBoard) => BuyoutBoard) => {
      setBoard((prev) => {
        const next = mutator(prev);
        pending.current = next;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void flush(), 700);
        return next;
      });
    },
    [flush]
  );

  // Save on unmount if a write is still pending.
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
      if (pending.current) void flush();
    };
  }, [flush]);

  return { board, update, saveState };
}
