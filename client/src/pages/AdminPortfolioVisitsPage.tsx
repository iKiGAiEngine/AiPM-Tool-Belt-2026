import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Eye, Users, Clock, Globe, RefreshCw, Loader2 } from "lucide-react";
import { BackNav } from "@/components/BackNav";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { queryClient } from "@/lib/queryClient";

interface PortfolioVisit {
  id: number;
  visitedAt: string;
  ip: string | null;
  userAgent: string | null;
  referer: string | null;
  acceptLanguage: string | null;
  path: string | null;
}

interface PortfolioVisitsResponse {
  total: number;
  uniqueIps: number;
  visits: PortfolioVisit[];
}

function parseDevice(ua: string | null): string {
  if (!ua) return "Unknown";
  const u = ua.toLowerCase();
  if (u.includes("iphone")) return "iPhone";
  if (u.includes("ipad")) return "iPad";
  if (u.includes("android")) return "Android";
  if (u.includes("mac os") || u.includes("macintosh")) return "Mac";
  if (u.includes("windows")) return "Windows";
  if (u.includes("linux")) return "Linux";
  if (u.includes("curl") || u.includes("bot") || u.includes("crawler") || u.includes("spider")) return "Bot/Script";
  return "Other";
}

function parseBrowser(ua: string | null): string {
  if (!ua) return "—";
  if (/edg\//i.test(ua)) return "Edge";
  if (/chrome\//i.test(ua) && !/chromium/i.test(ua)) return "Chrome";
  if (/safari\//i.test(ua) && !/chrome/i.test(ua)) return "Safari";
  if (/firefox\//i.test(ua)) return "Firefox";
  if (/curl/i.test(ua)) return "curl";
  return "Other";
}

function parseReferer(ref: string | null): string {
  if (!ref) return "Direct / link";
  try {
    const u = new URL(ref);
    const host = u.hostname.replace(/^www\./, "");
    if (host.includes("mail.google")) return "Gmail";
    if (host.includes("outlook") || host.includes("office.com")) return "Outlook";
    if (host.includes("slack")) return "Slack";
    if (host.includes("teams.microsoft")) return "Teams";
    if (host.includes("linkedin")) return "LinkedIn";
    if (host.includes("facebook")) return "Facebook";
    if (host.includes("twitter") || host === "x.com" || host === "t.co") return "Twitter/X";
    if (host.includes("google")) return "Google";
    return host;
  } catch {
    return ref.length > 30 ? ref.slice(0, 30) + "…" : ref;
  }
}

function parseLanguage(lang: string | null): string {
  if (!lang) return "—";
  const first = lang.split(",")[0].trim();
  return first || "—";
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

export default function AdminPortfolioVisitsPage() {
  const { data, isLoading, isFetching } = useQuery<PortfolioVisitsResponse>({
    queryKey: ["/api/admin/portfolio-visits"],
    refetchInterval: 30000,
  });

  const last24h = useMemo(() => {
    if (!data?.visits) return 0;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return data.visits.filter(v => new Date(v.visitedAt).getTime() > cutoff).length;
  }, [data]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/portfolio-visits"] });

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <BackNav href="/admin" label="Admin Dashboard" testId="button-back-admin" />
            <div>
              <h1 className="text-2xl font-semibold tracking-tight" data-testid="heading-portfolio-visits">
                Portfolio Visits
              </h1>
              <p className="text-sm text-muted-foreground">
                Anonymous tracking of visits to <span className="font-mono">/portfolio</span>
              </p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={refresh} disabled={isFetching} data-testid="button-refresh">
            {isFetching ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            <span className="ml-1.5">Refresh</span>
          </Button>
        </div>

        {/* Summary tiles */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
          <Card className="p-5" data-testid="card-stat-total">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground mb-2">
              <Eye className="w-3.5 h-3.5" /> Total visits
            </div>
            <div className="text-3xl font-semibold">{isLoading ? "—" : (data?.total ?? 0)}</div>
          </Card>
          <Card className="p-5" data-testid="card-stat-unique">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground mb-2">
              <Users className="w-3.5 h-3.5" /> Unique visitors (by IP)
            </div>
            <div className="text-3xl font-semibold">{isLoading ? "—" : (data?.uniqueIps ?? 0)}</div>
          </Card>
          <Card className="p-5" data-testid="card-stat-24h">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground mb-2">
              <Clock className="w-3.5 h-3.5" /> Last 24 hours
            </div>
            <div className="text-3xl font-semibold">{isLoading ? "—" : last24h}</div>
          </Card>
        </div>

        {/* Help note */}
        <Card className="p-4 mb-6 bg-muted/40 border-dashed">
          <div className="flex items-start gap-3 text-sm">
            <Globe className="w-4 h-4 mt-0.5 text-muted-foreground shrink-0" />
            <div className="text-muted-foreground leading-relaxed">
              <strong className="text-foreground">How to read this:</strong> each row is one visit to the portfolio page.
              We don't know who they are by name, but the <strong className="text-foreground">"Came from"</strong> column often hints at the source (e.g. Gmail means they clicked your email link).
              <strong className="text-foreground"> Tip:</strong> add <span className="font-mono text-xs bg-background px-1.5 py-0.5 rounded">?ref=director</span> to the link you share with someone — it'll show up in the Path column so you can tell their visit apart.
            </div>
          </div>
        </Card>

        {/* Visit list */}
        <Card className="overflow-hidden" data-testid="card-visits-table">
          {isLoading ? (
            <div className="py-16 text-center text-muted-foreground">
              <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
              Loading visits...
            </div>
          ) : !data || data.visits.length === 0 ? (
            <div className="py-16 text-center text-muted-foreground" data-testid="empty-state">
              <Eye className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <div className="font-medium">No visits yet</div>
              <div className="text-sm mt-1">Visits to <span className="font-mono">aipmapp.com/portfolio</span> will show up here.</div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium">When</th>
                    <th className="text-left px-4 py-3 font-medium">Came from</th>
                    <th className="text-left px-4 py-3 font-medium">Device</th>
                    <th className="text-left px-4 py-3 font-medium">Browser</th>
                    <th className="text-left px-4 py-3 font-medium">Language</th>
                    <th className="text-left px-4 py-3 font-medium">IP</th>
                    <th className="text-left px-4 py-3 font-medium">Path</th>
                  </tr>
                </thead>
                <tbody>
                  {data.visits.map((v) => {
                    const device = parseDevice(v.userAgent);
                    const browser = parseBrowser(v.userAgent);
                    const ref = parseReferer(v.referer);
                    const lang = parseLanguage(v.acceptLanguage);
                    const isBot = device === "Bot/Script";
                    return (
                      <tr key={v.id} className="border-t hover:bg-muted/30" data-testid={`row-visit-${v.id}`}>
                        <td className="px-4 py-3 align-top">
                          <div className="font-medium" data-testid={`text-when-${v.id}`}>{timeAgo(v.visitedAt)}</div>
                          <div className="text-xs text-muted-foreground mt-0.5">{formatDate(v.visitedAt)}</div>
                        </td>
                        <td className="px-4 py-3 align-top">
                          <Badge variant={v.referer ? "default" : "secondary"} className="font-normal" data-testid={`badge-referer-${v.id}`}>
                            {ref}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 align-top">
                          {isBot ? (
                            <Badge variant="outline" className="text-amber-700 border-amber-300">{device}</Badge>
                          ) : (
                            <span data-testid={`text-device-${v.id}`}>{device}</span>
                          )}
                        </td>
                        <td className="px-4 py-3 align-top text-muted-foreground">{browser}</td>
                        <td className="px-4 py-3 align-top text-muted-foreground font-mono text-xs">{lang}</td>
                        <td className="px-4 py-3 align-top text-muted-foreground font-mono text-xs" data-testid={`text-ip-${v.id}`}>
                          {v.ip || "—"}
                        </td>
                        <td className="px-4 py-3 align-top text-muted-foreground font-mono text-xs">{v.path || "/portfolio"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
