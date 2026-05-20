import { useMemo, useState } from "react";
import {
  Home, Wrench, Receipt, FlaskConical, Loader2, Shield, LogOut, KeyRound,
  FolderPlus, ScanSearch, ClipboardList, TableProperties, Settings, Users, Calculator, type LucideIcon
} from "lucide-react";
import { Link, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { useTestMode } from "@/lib/testMode";
import { useAuth } from "@/lib/auth";
import { useFeatureAccess } from "@/hooks/use-feature-access";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/ThemeToggle";
import { NotificationBell } from "@/components/NotificationBell";
import { SupportChatWidget } from "@/components/SupportChatWidget";
import { useToast } from "@/hooks/use-toast";
import type { Project } from "@shared/schema";

interface ToolRoute {
  path: string;
  label: string;
  icon: LucideIcon;
}

const toolRoutes: ToolRoute[] = [
  { path: "/project-start", label: "Project Start", icon: FolderPlus },
  { path: "/planparser", label: "Plan Parser", icon: ScanSearch },
  { path: "/quoteparser", label: "Quote Parser", icon: Receipt },
  { path: "/schedule-converter", label: "Schedule Converter", icon: TableProperties },
  { path: "/spec-extractor", label: "Spec Extractor", icon: ClipboardList },
  { path: "/tools/proposal-log", label: "Proposal Log Dashboard", icon: ClipboardList },
  { path: "/estimates", label: "Estimator", icon: Calculator },
  { path: "/settings", label: "Settings", icon: Settings },
  { path: "/admin", label: "Admin", icon: Shield },
];

function HexagonLogo() {
  return (
    <div
      className="flex h-9 w-9 items-center justify-center"
      style={{
        clipPath: "polygon(50% 0%,100% 25%,100% 75%,50% 100%,0% 75%,0% 25%)",
        background: "linear-gradient(135deg, var(--gold), var(--gold-dim))",
      }}
    >
      <Wrench className="h-4.5 w-4.5" style={{ color: "var(--bg)" }} />
    </div>
  );
}

function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [localError, setLocalError] = useState("");

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message);
      return data;
    },
    onSuccess: () => {
      toast({ title: "Password changed", description: "Your password has been updated." });
      setCurrent(""); setNext(""); setConfirm(""); setLocalError("");
      onClose();
    },
    onError: (err: Error) => {
      setLocalError(err.message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError("");
    if (next.length < 8) { setLocalError("New password must be at least 8 characters."); return; }
    if (next !== confirm) { setLocalError("Passwords do not match."); return; }
    mutation.mutate();
  };

  const inputCls = "w-full rounded-md border px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-yellow-500/40";

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { setCurrent(""); setNext(""); setConfirm(""); setLocalError(""); onClose(); } }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" style={{ color: "var(--gold)" }} />
            Change Password
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3 pt-1">
          <div>
            <label className="block text-xs font-medium mb-1 text-muted-foreground">Current Password</label>
            <input
              type="password"
              className={inputCls}
              value={current}
              onChange={e => setCurrent(e.target.value)}
              required
              autoComplete="current-password"
              autoFocus
              data-testid="input-current-password"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1 text-muted-foreground">New Password</label>
            <input
              type="password"
              className={inputCls}
              placeholder="At least 8 characters"
              value={next}
              onChange={e => setNext(e.target.value)}
              required
              autoComplete="new-password"
              data-testid="input-new-password"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1 text-muted-foreground">Confirm New Password</label>
            <input
              type="password"
              className={inputCls}
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              required
              autoComplete="new-password"
              data-testid="input-confirm-new-password"
            />
          </div>
          {localError && <p className="text-xs text-destructive" data-testid="text-change-pw-error">{localError}</p>}
          <DialogFooter className="pt-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={mutation.isPending}>Cancel</Button>
            <Button
              type="submit"
              size="sm"
              disabled={mutation.isPending || !current || !next || !confirm}
              style={{ background: "linear-gradient(135deg, var(--gold), var(--gold-dim))", color: "var(--bg)" }}
              data-testid="button-change-password"
            >
              {mutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Update Password"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function Header() {
  const [location, navigate] = useLocation();
  const { isTestMode, toggleTestMode, isLockedOn } = useTestMode();
  const { user, isAdmin, isViewer, canAccessAdminDashboard, isLoading: authLoading, logout } = useAuth();
  const { hasFeature, isLoading: featuresLoading } = useFeatureAccess();
  const canSettingsRegions = hasFeature("settings-regions");
  const canSettingsFull = hasFeature("central-settings");
  const isHome = location === "/";
  const [changePwOpen, setChangePwOpen] = useState(false);

  const activeToolRoute = useMemo(() => {
    if (location.startsWith("/estimates/")) {
      return { path: "/estimates", label: "Estimating Module", icon: Calculator };
    }
    return toolRoutes.find(r => location.startsWith(r.path));
  }, [location]);

  const { data: allProjects } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
    refetchInterval: 5000,
  });

  const processingProjects = useMemo(() => {
    if (!allProjects) return [];
    return allProjects.filter(p => p.status === "processing");
  }, [allProjects]);

  const settingsReady = !authLoading && !featuresLoading;

  return (
    <>
      <ChangePasswordDialog open={changePwOpen} onClose={() => setChangePwOpen(false)} />
      <header
        className="sticky top-0 z-50 flex h-14 items-center gap-4 border-b px-4 md:px-6"
        style={{ background: "var(--bg-header)", borderColor: "var(--border-ds)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)" }}
      >
        <div className="flex flex-1 items-center gap-4">
          <Link href="/" className="flex items-center gap-2.5" data-testid="link-logo">
            <HexagonLogo />
            <span className="hidden font-bold text-base leading-tight font-heading sm:inline-block" style={{ color: "var(--text)" }}>
              AiPM Tool Belt
            </span>
          </Link>

          {user && <SupportChatWidget />}

          {activeToolRoute && (
            <>
              <div className="h-5 w-px" style={{ background: "var(--border-ds)" }} />
              <div className="flex items-center gap-1.5">
                <activeToolRoute.icon className="h-4 w-4" style={{ color: "var(--gold)" }} />
                <span className="text-sm font-medium font-heading" style={{ color: "var(--text)" }} data-testid="text-active-tool">
                  {activeToolRoute.label}
                </span>
              </div>
            </>
          )}
        </div>

        <nav className="hidden items-center gap-6 md:flex">
          {!isHome && (
            <Link
              href="/"
              className="flex items-center gap-2 text-sm font-medium transition-colors font-heading"
              style={{ color: "var(--text-dim)" }}
              data-testid="link-nav-home"
            >
              <Home className="h-4 w-4" />
              Home
            </Link>
          )}
        </nav>

        <div className="flex items-center gap-3">
          {processingProjects.length > 0 && (
            <button
              onClick={() => navigate(`/projects/${processingProjects[0].id}`)}
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium font-heading hover-elevate cursor-pointer"
              style={{ color: "var(--gold)", background: "rgba(201,168,76,0.1)" }}
              data-testid="button-processing-indicator"
            >
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>{processingProjects.length} processing</span>
            </button>
          )}
          {(isAdmin || isViewer) && (
            <label
              className="flex items-center gap-2"
              data-testid="toggle-test-mode"
              style={{ cursor: isLockedOn ? "not-allowed" : "pointer" }}
              title={isLockedOn ? "Test mode is locked on for read-only accounts" : undefined}
            >
              <FlaskConical className={cn("h-4 w-4")} style={{ color: isTestMode ? "var(--gold)" : "var(--text-dim)" }} />
              <span className="text-xs font-medium select-none font-heading" style={{ color: isTestMode ? "var(--gold)" : "var(--text-dim)" }}>
                Test
              </span>
              <Switch
                checked={isTestMode}
                onCheckedChange={isLockedOn ? undefined : toggleTestMode}
                disabled={isLockedOn}
                className="data-[state=checked]:bg-primary"
              />
            </label>
          )}
          {settingsReady && (isAdmin || canSettingsFull || canSettingsRegions) && (
            <Link href="/settings">
              <Button variant="ghost" size="icon" title={isAdmin || canSettingsFull ? "Settings" : "Regions"} data-testid="link-settings">
                <Settings className="h-4 w-4" />
              </Button>
            </Link>
          )}
          {canAccessAdminDashboard && (
            <Link href="/admin">
              <Button variant="ghost" size="icon" title="Admin" data-testid="link-admin">
                <Shield className="h-4 w-4" />
              </Button>
            </Link>
          )}
          {isAdmin && (
            <Link href="/admin/permissions">
              <Button variant="ghost" size="icon" title="User Permissions" data-testid="link-admin-permissions">
                <Users className="h-4 w-4" />
              </Button>
            </Link>
          )}
          <NotificationBell />
          <ThemeToggle />
          <div className="flex items-center gap-1">
            {user && (
              <span className="text-xs hidden sm:inline" style={{ color: "var(--text-dim)" }} data-testid="text-user-email">
                {user.email}
              </span>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setChangePwOpen(true)}
              title="Change password"
              data-testid="button-change-password-open"
            >
              <KeyRound className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={logout} title="Sign out" data-testid="button-logout">
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>
      {isAdmin && isTestMode && (
        <div
          className="sticky top-14 z-40 flex items-center justify-center gap-2 px-4 py-1.5 text-sm font-bold font-heading uppercase tracking-wider"
          style={{ background: "linear-gradient(135deg, var(--gold), var(--gold-dim))", color: "var(--bg)" }}
          data-testid="banner-test-mode"
        >
          <FlaskConical className="h-4 w-4" />
          Test Mode Active
        </div>
      )}
    </>
  );
}
