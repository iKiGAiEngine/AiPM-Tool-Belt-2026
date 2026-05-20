import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Loader2, RotateCcw, Shield, ShieldCheck, Info } from "lucide-react";
import { BackNav } from "@/components/BackNav";
import { ROLE_LABELS } from "@shared/schema";
import { Link } from "wouter";

interface UserWithPermissions {
  id: number;
  email: string;
  displayName?: string;
  role: string;
  features: string[];
  availableFeatures: string[];
}

const FEATURE_LABELS: Record<string, string> = {
  "proposal-log": "Proposal Log",
  "vendor-database": "Vendor / Manufacturer Database",
  "submittal-builder": "Submittal Builder",
  "schedule-converter": "Schedule Converter",
  "spec-extractor": "Spec Extractor",
  "quote-parser": "Quote Parser",
  "plan-parser": "Plan Parser",
  "bc-sync": "BuildingConnected Sync",
  "draft-review": "Draft Review",
  "central-settings": "Central Settings (Full Access)",
  "project-start": "Project Start",
  "estimating-module": "Estimating Module",
  "rfq-vendor-lookup": "RFQ Vendor Lookup (Approved Mfrs)",
  "procurement-process": "Procurement Process",
  "settings-regions": "Settings — Regions Tab Only",
};

export function AdminUserPermissionsPage() {
  const { toast } = useToast();
  const [selectedUser, setSelectedUser] = useState<number | null>(null);

  const { data: rawUsers = [], isLoading } = useQuery({
    queryKey: ["/api/admin/users/permissions/matrix"],
    queryFn: async () => {
      const res = await fetch("/api/admin/users/permissions/matrix");
      if (!res.ok) throw new Error("Failed to fetch permissions");
      return res.json() as Promise<UserWithPermissions[]>;
    },
  });

  const users = useMemo(
    () => Array.from(new Map(rawUsers.map((u) => [u.id, u])).values()),
    [rawUsers]
  );

  useEffect(() => {
    setSelectedUser((cur) => cur ?? users[0]?.id ?? null);
  }, [users]);

  function invalidateAll() {
    queryClient.invalidateQueries({ queryKey: ["/api/admin/users/permissions/matrix"] });
    queryClient.invalidateQueries({ queryKey: ["/api/user/features"] });
  }

  const grantMutation = useMutation({
    mutationFn: async ({ userId, feature }: { userId: number; feature: string }) =>
      apiRequest("POST", `/api/admin/users/${userId}/permissions/grant`, { feature }),
    onSuccess: () => {
      invalidateAll();
      toast({ title: "Feature granted" });
    },
    onError: () => toast({ title: "Failed to grant feature", variant: "destructive" }),
  });

  const revokeMutation = useMutation({
    mutationFn: async ({ userId, feature }: { userId: number; feature: string }) =>
      apiRequest("POST", `/api/admin/users/${userId}/permissions/revoke`, { feature }),
    onSuccess: () => {
      invalidateAll();
      toast({ title: "Feature revoked" });
    },
    onError: () => toast({ title: "Failed to revoke feature", variant: "destructive" }),
  });

  const resetMutation = useMutation({
    mutationFn: async (userId: number) =>
      apiRequest("POST", `/api/admin/users/${userId}/reset-permissions`, {}),
    onSuccess: () => {
      invalidateAll();
      toast({ title: "Permissions reset to role defaults" });
    },
    onError: () => toast({ title: "Failed to reset permissions", variant: "destructive" }),
  });

  const selectedUserData = users.find((u) => u.id === selectedUser);
  const currentFeatures = new Set(selectedUserData?.features ?? []);
  const availableFeatures = selectedUserData?.availableFeatures ?? [];
  const isBusy = grantMutation.isPending || revokeMutation.isPending;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-8 h-8 animate-spin" style={{ color: "var(--gold)" }} />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-start gap-3">
        <BackNav href="/admin" label="Admin Dashboard" testId="button-back-admin" />
        <div>
          <h1 className="text-2xl font-heading font-semibold text-foreground">User Feature Access</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Control which tools each user can access. Role is set in the{" "}
            <Link href="/admin" className="underline hover:text-foreground">Admin Dashboard</Link>{" "}
            and determines their default features — you can customize further here.
          </p>
        </div>
      </div>

      {/* How it works callout */}
      <div className="flex gap-3 rounded-lg border border-border bg-muted/40 p-4">
        <Info className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
        <div className="text-sm text-muted-foreground space-y-1">
          <p>
            <span className="font-medium text-foreground">Role</span> (Admin or Estimator) is assigned in the Admin Dashboard.
            Changing a role automatically resets that user's feature access to the role defaults.
          </p>
          <p>
            <span className="font-medium text-foreground">Feature Access</span> lets you go further — grant or revoke individual
            tools without changing the user's role. Use "Reset to Defaults" to undo any manual overrides.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* User list */}
        <Card className="col-span-1 card-accent-bar" data-testid="card-user-list">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Users</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="space-y-1">
              {users.map((user) => (
                <button
                  key={user.id}
                  onClick={() => setSelectedUser(user.id)}
                  className={`w-full text-left px-3 py-2.5 rounded-md transition-colors ${
                    selectedUser === user.id
                      ? "bg-gold/15 border border-gold/40"
                      : "hover:bg-muted border border-transparent"
                  }`}
                  data-testid={`user-button-${user.id}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium text-sm truncate">
                      {user.displayName || user.email}
                    </div>
                    <Badge
                      variant={user.role === "admin" ? "default" : "secondary"}
                      className="text-xs shrink-0"
                    >
                      {user.role === "admin" ? (
                        <><ShieldCheck className="w-3 h-3 mr-1" />Admin</>
                      ) : (
                        ROLE_LABELS[user.role] || user.role
                      )}
                    </Badge>
                  </div>
                  {user.displayName && (
                    <div className="text-xs text-muted-foreground mt-0.5">{user.email}</div>
                  )}
                  <div className="text-xs text-muted-foreground mt-1">
                    {user.features.length} of {user.availableFeatures.length} features active
                  </div>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Feature access panel */}
        <Card className="col-span-2 card-accent-bar" data-testid="card-permission-matrix">
          <CardHeader className="pb-3">
            {selectedUserData ? (
              <div className="flex justify-between items-start">
                <div>
                  <CardTitle className="text-base">
                    {selectedUserData.displayName || selectedUserData.email}
                  </CardTitle>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs text-muted-foreground">Role:</span>
                    <Badge
                      variant={selectedUserData.role === "admin" ? "default" : "secondary"}
                      className="text-xs"
                    >
                      {selectedUserData.role === "admin" ? (
                        <><ShieldCheck className="w-3 h-3 mr-1" />Admin</>
                      ) : (
                        ROLE_LABELS[selectedUserData.role] || selectedUserData.role
                      )}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      — change role in{" "}
                      <Link href="/admin" className="underline hover:text-foreground">
                        Admin Dashboard
                      </Link>
                    </span>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => resetMutation.mutate(selectedUser!)}
                  disabled={resetMutation.isPending}
                  data-testid="button-reset-permissions"
                >
                  {resetMutation.isPending ? (
                    <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
                  )}
                  Reset to Defaults
                </Button>
              </div>
            ) : (
              <CardTitle className="text-base text-muted-foreground">Select a user</CardTitle>
            )}
          </CardHeader>

          <CardContent className="pt-0">
            {selectedUserData && (
              <div className="divide-y divide-border rounded-md border border-border overflow-hidden">
                {availableFeatures.map((feature) => {
                  const active = currentFeatures.has(feature);
                  return (
                    <div
                      key={feature}
                      className="flex items-center justify-between px-4 py-3 bg-card hover:bg-muted/30 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className={`w-2 h-2 rounded-full shrink-0 ${active ? "bg-green-500" : "bg-muted-foreground/30"}`}
                        />
                        <span className="text-sm">{FEATURE_LABELS[feature] || feature}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`text-xs ${active ? "text-green-600" : "text-muted-foreground"}`}>
                          {active ? "Active" : "No access"}
                        </span>
                        <Button
                          size="sm"
                          variant={active ? "outline" : "default"}
                          className={active ? "border-red-500/40 text-red-600 hover:bg-red-500/10 hover:border-red-500" : ""}
                          onClick={() =>
                            active
                              ? revokeMutation.mutate({ userId: selectedUser!, feature })
                              : grantMutation.mutate({ userId: selectedUser!, feature })
                          }
                          disabled={isBusy}
                          data-testid={`button-toggle-feature-${feature}`}
                        >
                          {active ? "Revoke" : "Grant"}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
