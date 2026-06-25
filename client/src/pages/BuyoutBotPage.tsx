// Buyout Bot — top-level page. Switches between the project log (home) and the
// board for one project. The board is the deep-link target via ?project=<id>.

import { useState, useEffect } from "react";
import { useSearch } from "wouter";
import { PackageCheck } from "lucide-react";
import { BackNav } from "@/components/BackNav";
import { ProjectLog } from "@/buyout/ProjectLog";
import { BuyoutBoardView } from "@/buyout/BuyoutBoard";
import { useToolUsage } from "@/lib/useToolUsage";

export default function BuyoutBotPage() {
  const search = useSearch();
  const initialId = (() => {
    const id = new URLSearchParams(search).get("project");
    return id ? Number(id) : null;
  })();
  const [openId, setOpenId] = useState<number | null>(initialId);
  useToolUsage("buyout-bot");

  // Keep the URL in sync so a refresh resumes the same board.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (openId) url.searchParams.set("project", String(openId));
    else url.searchParams.delete("project");
    window.history.replaceState({}, "", url.toString());
  }, [openId]);

  if (openId) {
    return (
      <div className="min-h-screen bg-background">
        <BuyoutBoardView projectId={openId} onBack={() => setOpenId(null)} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-5xl mx-auto px-4 pt-4">
        <BackNav href="/" label="Tool Belt" />
        <div className="flex items-center gap-3 mt-2 mb-1">
          <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: "var(--warning-bg)" }}>
            <PackageCheck className="w-5 h-5" style={{ color: "var(--gold)" }} />
          </div>
          <div>
            <h1 className="font-heading text-2xl font-bold text-foreground leading-tight">Buyout Bot</h1>
            <p className="text-sm text-muted-foreground">Drop an NBS estimate to track buyout — RFQs, quotes, awards & POs</p>
          </div>
        </div>
      </div>
      <ProjectLog onOpen={setOpenId} />
    </div>
  );
}
