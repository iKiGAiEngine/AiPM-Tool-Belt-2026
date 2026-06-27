import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, Percent } from "lucide-react";
import { BackNav } from "@/components/BackNav";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { TaxRate } from "@shared/schema";

export default function TaxRateLookupPage() {
  const [inputZip, setInputZip] = useState("");
  const [searchZip, setSearchZip] = useState("");

  const { data: results, isLoading, isFetching, isError } = useQuery<TaxRate[]>({
    queryKey: ["/api/tax-rates/lookup", searchZip],
    queryFn: async () => {
      const res = await fetch(`/api/tax-rates/lookup?zip=${encodeURIComponent(searchZip)}`);
      if (!res.ok) throw new Error("Lookup failed");
      return res.json();
    },
    enabled: !!searchZip,
  });

  const { data: status } = useQuery<{ rowCount: number; lastUploadedAt: string | null }>({
    queryKey: ["/api/tax-rates/status"],
    queryFn: async () => {
      const res = await fetch("/api/tax-rates/status");
      if (!res.ok) throw new Error("Status failed");
      return res.json();
    },
  });

  const handleSearch = () => {
    const z = inputZip.trim();
    if (z) setSearchZip(z);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSearch();
  };

  const formatRate = (rate: string | null) => {
    if (rate === null || rate === undefined) return "—";
    const n = parseFloat(rate);
    if (isNaN(n)) return "—";
    // Show as clean percentage: "6%", "6.5%", "8.25%" — no trailing zeros
    const formatted = parseFloat(n.toFixed(4)).toString();
    return `${formatted}%`;
  };

  const hasResults = results && results.length > 0;
  const noResults = searchZip && !isLoading && !isFetching && results && results.length === 0;

  return (
    <div className="container max-w-3xl mx-auto py-8 px-4 animate-page-enter">
      <div className="flex items-center gap-4 mb-8">
        <BackNav href="/" label="Home" testId="button-back" />
        <div className="flex-1">
          <h1 className="text-2xl font-semibold text-foreground font-heading flex items-center gap-2">
            <Percent className="w-6 h-6 text-primary" />
            Tax Rate Lookup
          </h1>
          <p className="text-muted-foreground text-sm">
            Enter a zip code to find the applicable use tax rate.
            {status && status.rowCount > 0 && (
              <span className="ml-2 text-muted-foreground/70">
                ({status.rowCount.toLocaleString()} records loaded)
              </span>
            )}
          </p>
        </div>
      </div>

      <Card className="mb-6">
        <CardContent className="pt-6">
          <div className="flex gap-3 items-end">
            <div className="flex-1">
              <Label htmlFor="zip-input" className="mb-1.5 block">Zip Code</Label>
              <Input
                id="zip-input"
                placeholder="e.g. 90210"
                value={inputZip}
                onChange={(e) => setInputZip(e.target.value)}
                onKeyDown={handleKeyDown}
                maxLength={10}
                className="text-base"
              />
            </div>
            <Button onClick={handleSearch} disabled={!inputZip.trim()} className="gap-2">
              <Search className="w-4 h-4" />
              Search
            </Button>
          </div>
        </CardContent>
      </Card>

      {(isLoading || isFetching) && (
        <p className="text-muted-foreground text-sm">Searching…</p>
      )}

      {isError && (
        <p className="text-destructive text-sm">Error looking up zip code. Please try again.</p>
      )}

      {noResults && (
        <p className="text-muted-foreground text-sm">No tax rate records found for zip code <strong>{searchZip}</strong>.</p>
      )}

      {!status?.rowCount && !isLoading && (
        <p className="text-muted-foreground/70 text-sm">No tax rate data has been uploaded yet. An admin can upload the Avalara spreadsheet in <a href="/settings" className="underline">Settings → Tax Rates</a>.</p>
      )}

      {hasResults && (
        <div className="space-y-4">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Results for {searchZip} — {results.length} {results.length === 1 ? "match" : "matches"}
          </h2>
          {results.map((r) => (
            <Card key={r.id} className="border-l-4 border-l-primary">
              <CardHeader className="pb-2 pt-4 px-5">
                <CardTitle className="text-base font-heading">
                  {[r.city, r.county, r.state].filter(Boolean).join(", ") || "Unknown location"}
                </CardTitle>
              </CardHeader>
              <CardContent className="px-5 pb-4">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                  <div>
                    <p className="text-muted-foreground text-xs uppercase tracking-wide mb-0.5">State</p>
                    <p className="font-medium">{r.state || "—"}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs uppercase tracking-wide mb-0.5">County</p>
                    <p className="font-medium">{r.county || "—"}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs uppercase tracking-wide mb-0.5">City</p>
                    <p className="font-medium">{r.city || "—"}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs uppercase tracking-wide mb-0.5">Total Use Tax</p>
                    <p className="font-semibold text-primary text-base">{formatRate(r.totalUseTax)}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
