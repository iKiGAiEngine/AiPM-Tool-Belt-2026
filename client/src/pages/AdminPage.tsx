import { useState, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ArrowLeft,
  Shield,
  ShieldCheck,
  UserCheck,
  UserX,
  Loader2,
  ScrollText,
  Plus,
  Pencil,
  Download,
  Upload,
  Database,
  AlertTriangle,
  CheckCircle,
  HardDrive,
  BookOpen,
  History,
  FileText,
  KeyRound,
  ClipboardList,
  Trash2,
  Mail,
  Link2,
} from "lucide-react";
import { Link } from "wouter";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { User } from "@shared/schema";
import { ROLE_LABELS } from "@shared/schema";

function UserFormDialog({
  open,
  onOpenChange,
  editUser,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editUser: User | null;
}) {
  const { toast } = useToast();
  const [email, setEmail] = useState(editUser?.email || "");
  const [displayName, setDisplayName] = useState(editUser?.displayName || "");
  const [initials, setInitials] = useState(editUser?.initials || "");
  const [role, setRole] = useState(editUser?.role || "admin");
  const [dashboardScope, setDashboardScope] = useState((editUser as any)?.dashboardScope || "my_projects");
  const [dashboardLayout, setDashboardLayout] = useState((editUser as any)?.dashboardLayout || "estimator");

  const isEditing = !!editUser;

  const createMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/admin/users", {
        email, displayName, initials, role,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      toast({ title: "User created" });
      onOpenChange(false);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("PATCH", `/api/admin/users/${editUser!.id}/profile`, {
        email, displayName, initials, role, dashboardScope, dashboardLayout,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      toast({ title: "Profile updated" });
      onOpenChange(false);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isEditing) {
      updateMutation.mutate();
    } else {
      createMutation.mutate();
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit User Profile" : "Add New User"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-2">
            <Label htmlFor="form-email">Email Address</Label>
            <Input
              id="form-email"
              type="email"
              placeholder="user@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              data-testid="input-form-email"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="form-name">Display Name</Label>
            <Input
              id="form-name"
              placeholder="John Smith"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              data-testid="input-form-name"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="form-initials">Initials</Label>
            <Input
              id="form-initials"
              placeholder="HK"
              value={initials}
              onChange={(e) => setInitials(e.target.value.toUpperCase())}
              maxLength={4}
              data-testid="input-form-initials"
            />
            <p className="text-xs text-muted-foreground">Used as estimator code in Proposal Log</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="form-role">Role</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger id="form-role" data-testid="select-form-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="user">User</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="form-dashboard-scope">Dashboard Scope</Label>
            <Select value={dashboardScope} onValueChange={setDashboardScope}>
              <SelectTrigger id="form-dashboard-scope" data-testid="select-form-dashboard-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="my_projects">My Projects</SelectItem>
                <SelectItem value="my_region">My Region</SelectItem>
                <SelectItem value="company_wide">Company Wide</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Controls which project records are shown on the dashboard by default</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="form-dashboard-layout">Dashboard Layout</Label>
            <Select value={dashboardLayout} onValueChange={setDashboardLayout}>
              <SelectTrigger id="form-dashboard-layout" data-testid="select-form-dashboard-layout">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="estimator">Estimator</SelectItem>
                <SelectItem value="project_manager">Project Manager</SelectItem>
                <SelectItem value="executive">Executive</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Controls which dashboard widgets are shown</p>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} data-testid="button-form-cancel">
              Cancel
            </Button>
            <Button type="submit" disabled={isPending || !email.trim()} data-testid="button-form-save">
              {isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                isEditing ? "Save Changes" : "Create User"
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AdminUsersSection() {
  const { toast } = useToast();
  const [formOpen, setFormOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);

  const { data: usersList = [], isLoading, isError, refetch } = useQuery<User[]>({
    queryKey: ["/api/admin/users"],
    placeholderData: (prev) => prev,
  });

  const toggleActiveMutation = useMutation({
    mutationFn: async (userId: number) => {
      await apiRequest("PATCH", `/api/admin/users/${userId}/toggle-active`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      toast({ title: "User updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const resendInviteMutation = useMutation({
    mutationFn: async (userId: number) => {
      await apiRequest("POST", `/api/admin/users/${userId}/resend-invite`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      toast({ title: "Invite sent" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const changeRoleMutation = useMutation({
    mutationFn: async ({ userId, role }: { userId: number; role: string }) => {
      await apiRequest("PATCH", `/api/admin/users/${userId}/role`, { role });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      toast({ title: "Role updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteUserMutation = useMutation({
    mutationFn: async (userId: number) => {
      await apiRequest("DELETE", `/api/admin/users/${userId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      toast({ title: "User deleted" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteInactiveMutation = useMutation<{ deleted: number; emails: string[] }, Error>({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/cleanup/remove-inactive");
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      toast({ title: `Deleted ${data.deleted} inactive user${data.deleted !== 1 ? "s" : ""}` });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const handleDeleteUser = (u: User) => {
    if (!window.confirm(`Delete user "${u.displayName || u.email}"? This cannot be undone.`)) return;
    deleteUserMutation.mutate(u.id);
  };

  const bulkTempPasswordMutation = useMutation<{ updated: number; emails: string[] }, Error, { tempPassword: string; includeInactive: boolean }>({
    mutationFn: async (payload) => {
      const res = await apiRequest("POST", "/api/admin/users/bulk-set-temp-password", payload);
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      toast({
        title: `Temporary password set for ${data.updated} user${data.updated !== 1 ? "s" : ""}`,
        description: "Each user will be required to change it on next login.",
      });
    },
    onError: (err) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const handleBulkTempPassword = () => {
    const tempPassword = window.prompt(
      "Enter a temporary password (min 8 chars). It will be applied to ALL users except yourself. Each user will be forced to change it on next login.\n\nShare this password securely with your team.",
    );
    if (!tempPassword) return;
    if (tempPassword.length < 8) {
      toast({ title: "Password must be at least 8 characters", variant: "destructive" });
      return;
    }
    const includeInactive = window.confirm(
      "Include INACTIVE users too? Click OK to include them (they will also be activated). Click Cancel to apply to active users only.",
    );
    const targetCount = usersList.filter((u) => (includeInactive ? true : u.isActive)).length;
    if (!window.confirm(`This will set the temporary password "${tempPassword}" for ${targetCount} user(s) and require them to change it on next login. Continue?`)) return;
    bulkTempPasswordMutation.mutate({ tempPassword, includeInactive });
  };

  const handleDeleteAllInactive = () => {
    const inactiveCount = usersList.filter((u) => !u.isActive).length;
    if (inactiveCount === 0) {
      toast({ title: "No inactive users to delete" });
      return;
    }
    if (!window.confirm(`Delete all ${inactiveCount} inactive user${inactiveCount !== 1 ? "s" : ""}? This cannot be undone.`)) return;
    deleteInactiveMutation.mutate();
  };

  const openCreateDialog = () => {
    setEditingUser(null);
    setFormOpen(true);
  };

  const openEditDialog = (user: User) => {
    setEditingUser(user);
    setFormOpen(true);
  };

  return (
    <>
      {/* Logs & Audit Center — Admin Only (legacy link strip; the new /admin dashboard owns this surface) */}
      <Card className="card-accent-bar mb-6 hidden">
          <div className="p-4 border-b">
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4" style={{ color: "var(--gold)" }} />
              <h2 className="font-heading font-medium">Admin Tools</h2>
            </div>
            <p className="text-xs text-muted-foreground mt-1">Feature access, logs, and audit tools — restricted to administrators only.</p>
          </div>
          <div className="p-4 grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <Link href="/admin/permissions" data-testid="link-user-permissions">
              <div className="flex items-start gap-3 p-3 rounded-md border border-border hover:border-primary/50 hover:bg-muted/40 transition-all cursor-pointer group">
                <KeyRound className="w-4 h-4 mt-0.5 shrink-0" style={{ color: "var(--gold)" }} />
                <div>
                  <div className="font-medium text-sm font-heading group-hover:text-foreground">Feature Access</div>
                  <div className="text-xs text-muted-foreground">Control which tools each user can access</div>
                </div>
              </div>
            </Link>
            <Link href="/changelog" data-testid="link-changelog">
              <div className="flex items-start gap-3 p-3 rounded-md border border-border hover:border-primary/50 hover:bg-muted/40 transition-all cursor-pointer group">
                <BookOpen className="w-4 h-4 mt-0.5 shrink-0" style={{ color: "var(--gold)" }} />
                <div>
                  <div className="font-medium text-sm font-heading group-hover:text-foreground">Changelog</div>
                  <div className="text-xs text-muted-foreground">App version history, features added, bugs fixed</div>
                </div>
              </div>
            </Link>
            <Link href="/tools/proposal-log" data-testid="link-proposal-log">
              <div className="flex items-start gap-3 p-3 rounded-md border border-border hover:border-primary/50 hover:bg-muted/40 transition-all cursor-pointer group">
                <History className="w-4 h-4 mt-0.5 shrink-0" style={{ color: "var(--gold)" }} />
                <div>
                  <div className="font-medium text-sm font-heading group-hover:text-foreground">Proposal Log</div>
                  <div className="text-xs text-muted-foreground">Bid tracking, pipeline & estimating workflow</div>
                </div>
              </div>
            </Link>
            <Link href="/tools/bc-sync-table" data-testid="link-bc-sync-table">
              <div className="flex items-start gap-3 p-3 rounded-md border border-border hover:border-primary/50 hover:bg-muted/40 transition-all cursor-pointer group">
                <Link2 className="w-4 h-4 mt-0.5 shrink-0" style={{ color: "var(--gold)" }} />
                <div>
                  <div className="font-medium text-sm font-heading group-hover:text-foreground">BC Sync Table</div>
                  <div className="text-xs text-muted-foreground">BuildingConnected draft review, approval & change history</div>
                </div>
              </div>
            </Link>
            <Link href="/admin/proposal-change-log" data-testid="link-proposal-change-log">
              <div className="flex items-start gap-3 p-3 rounded-md border border-border hover:border-primary/50 hover:bg-muted/40 transition-all cursor-pointer group">
                <ClipboardList className="w-4 h-4 mt-0.5 shrink-0" style={{ color: "var(--gold)" }} />
                <div>
                  <div className="font-medium text-sm font-heading group-hover:text-foreground">Change Log</div>
                  <div className="text-xs text-muted-foreground">Full history of all edits &amp; new projects added</div>
                </div>
              </div>
            </Link>
            <Link href="/admin/estimator-analytics" data-testid="link-estimator-analytics">
              <div className="flex items-start gap-3 p-3 rounded-md border border-border hover:border-primary/50 hover:bg-muted/40 transition-all cursor-pointer group">
                <ScrollText className="w-4 h-4 mt-0.5 shrink-0" style={{ color: "var(--gold)" }} />
                <div>
                  <div className="font-medium text-sm font-heading group-hover:text-foreground">Estimator Analytics</div>
                  <div className="text-xs text-muted-foreground">Cycle times, active engagement, per-stage and per-scope time</div>
                </div>
              </div>
            </Link>
            <Link href="/admin/audit" data-testid="link-system-audit-log">
              <div className="flex items-start gap-3 p-3 rounded-md border border-border hover:border-primary/50 hover:bg-muted/40 transition-all cursor-pointer group">
                <ScrollText className="w-4 h-4 mt-0.5 shrink-0" style={{ color: "var(--gold)" }} />
                <div>
                  <div className="font-medium text-sm font-heading group-hover:text-foreground">System Audit Log</div>
                  <div className="text-xs text-muted-foreground">Authentication, role changes, admin actions</div>
                </div>
              </div>
            </Link>
          </div>
        </Card>

        <Card className="card-accent-bar">
          <div className="flex items-center justify-between gap-4 p-4 border-b flex-wrap">
            <h2 className="font-heading font-medium">Users</h2>
            <div className="flex items-center gap-2">
              {usersList.some((u) => !u.isActive) && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleDeleteAllInactive}
                  disabled={deleteInactiveMutation.isPending}
                  className="text-red-600 border-red-600/30 hover:bg-red-500/10"
                  data-testid="button-delete-inactive-users"
                >
                  {deleteInactiveMutation.isPending ? (
                    <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                  )}
                  Delete All Inactive
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={handleBulkTempPassword}
                disabled={bulkTempPasswordMutation.isPending}
                data-testid="button-bulk-temp-password"
              >
                {bulkTempPasswordMutation.isPending ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                ) : (
                  <KeyRound className="w-3.5 h-3.5 mr-1.5" />
                )}
                Set Temp Password for All
              </Button>
              <Button size="sm" onClick={openCreateDialog} data-testid="button-add-user">
                <Plus className="w-3.5 h-3.5 mr-1.5" />
                Add User
              </Button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Initials</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last Login</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && usersList.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-8">
                      <Loader2 className="w-5 h-5 animate-spin mx-auto text-muted-foreground" />
                    </TableCell>
                  </TableRow>
                ) : isError ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                      Failed to load users. <button type="button" onClick={() => refetch()} style={{ textDecoration: "underline" }}>Try again</button>
                    </TableCell>
                  </TableRow>
                ) : usersList.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                      No users yet. Click "Add User" to create one.
                    </TableCell>
                  </TableRow>
                ) : (
                  usersList.map((u) => (
                    <TableRow key={u.id} data-testid={`row-user-${u.id}`}>
                      <TableCell>
                        <div className="min-w-[180px]">
                          <div className="font-medium text-sm" data-testid={`text-email-${u.id}`}>
                            {u.displayName || u.email}
                          </div>
                          {u.displayName && (
                            <div className="text-xs text-muted-foreground">{u.email}</div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm font-medium" data-testid={`text-initials-${u.id}`}>
                        {u.initials || "-"}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={u.role === "admin" ? "default" : "secondary"}
                          className="text-xs"
                          data-testid={`badge-role-${u.id}`}
                        >
                          {u.role === "admin" ? (
                            <><ShieldCheck className="w-3 h-3 mr-1" />Admin</>
                          ) : (
                            ROLE_LABELS[u.role] || u.role
                          )}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={`text-xs ${u.isActive ? "text-green-600 border-green-600/30 bg-green-500/10" : "text-red-600 border-red-600/30 bg-red-500/10"}`}
                          data-testid={`badge-status-${u.id}`}
                        >
                          {u.isActive ? "Active" : "Inactive"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : "Never"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => openEditDialog(u)}
                            title="Edit profile"
                            data-testid={`button-edit-${u.id}`}
                          >
                            <Pencil className="w-4 h-4 text-muted-foreground" />
                          </Button>
                          <Link href="/admin/permissions">
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Manage feature access"
                              data-testid={`button-permissions-${u.id}`}
                            >
                              <KeyRound className="w-4 h-4 text-muted-foreground" />
                            </Button>
                          </Link>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => toggleActiveMutation.mutate(u.id)}
                            disabled={toggleActiveMutation.isPending}
                            title={u.isActive ? "Deactivate user" : "Activate user"}
                            data-testid={`button-toggle-active-${u.id}`}
                          >
                            {u.isActive ? (
                              <UserX className="w-4 h-4 text-muted-foreground" />
                            ) : (
                              <UserCheck className="w-4 h-4 text-green-600" />
                            )}
                          </Button>
                          {!u.isActive && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => resendInviteMutation.mutate(u.id)}
                              disabled={resendInviteMutation.isPending}
                              title="Resend invite"
                              data-testid={`button-resend-invite-${u.id}`}
                            >
                              <Mail className="w-4 h-4 text-muted-foreground" />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() =>
                              changeRoleMutation.mutate({
                                userId: u.id,
                                role: u.role === "admin" ? "user" : "admin",
                              })
                            }
                            disabled={changeRoleMutation.isPending}
                            title={u.role === "admin" ? "Demote to Estimator" : "Promote to Admin"}
                            data-testid={`button-change-role-${u.id}`}
                          >
                            {u.role === "admin" ? (
                              <ShieldCheck className="w-4 h-4" style={{ color: "var(--gold)" }} />
                            ) : (
                              <Shield className="w-4 h-4 text-muted-foreground" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDeleteUser(u)}
                            disabled={deleteUserMutation.isPending}
                            title="Delete user"
                            data-testid={`button-delete-${u.id}`}
                          >
                            <Trash2 className="w-4 h-4 text-red-500/70 hover:text-red-600" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </Card>

      {formOpen && (
        <UserFormDialog
          open={formOpen}
          onOpenChange={(open) => {
            setFormOpen(open);
            if (!open) setEditingUser(null);
          }}
          editUser={editingUser}
        />
      )}
    </>
  );
}

export function BackupRestoreSection() {
  const { toast } = useToast();
  const [downloading, setDownloading] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [selectedTables, setSelectedTables] = useState<string[]>([]);
  const [previewResult, setPreviewResult] = useState<any>(null);
  const [previewing, setPreviewing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: backupInfo, isLoading: infoLoading } = useQuery<{
    tables: { key: string; label: string; rowCount: number; restorable: boolean }[];
    totalRows: number;
  }>({
    queryKey: ["/api/admin/backup/info"],
  });

  const handleDownload = useCallback(async () => {
    setDownloading(true);
    try {
      const resp = await fetch("/api/admin/backup/download", { credentials: "include" });
      if (!resp.ok) throw new Error("Download failed");
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const disposition = resp.headers.get("Content-Disposition");
      const filename = disposition?.match(/filename="(.+)"/)?.[1] || "aipm-backup.xlsx";
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast({ title: "Backup downloaded", description: "Full database backup saved to your device." });
    } catch (err) {
      toast({ title: "Download failed", description: (err as Error).message, variant: "destructive" });
    } finally {
      setDownloading(false);
    }
  }, [toast]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setRestoreFile(file);
      setPreviewResult(null);
      setSelectedTables([]);
    }
  };

  const handlePreview = async () => {
    if (!restoreFile || selectedTables.length === 0) return;
    setPreviewing(true);
    try {
      const formData = new FormData();
      formData.append("file", restoreFile);
      formData.append("tables", JSON.stringify(selectedTables));
      const resp = await fetch("/api/admin/backup/restore", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.message);
      setPreviewResult(data);
    } catch (err) {
      toast({ title: "Preview failed", description: (err as Error).message, variant: "destructive" });
    } finally {
      setPreviewing(false);
    }
  };

  const toggleTable = (key: string) => {
    setSelectedTables(prev =>
      prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
    );
    setPreviewResult(null);
  };

  const restorableTables = backupInfo?.tables.filter(t => t.restorable) || [];

  return (
    <div className="max-w-5xl mx-auto px-6 pb-8">
      <Card className="card-accent-bar mt-6">
        <div className="flex items-center gap-3 p-4 border-b">
          <HardDrive className="w-5 h-5" style={{ color: "var(--gold)" }} />
          <h2 className="text-lg font-heading font-semibold text-foreground" data-testid="text-backup-title">
            Data Backup & Recovery
          </h2>
        </div>

        <div className="p-4 space-y-6">
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div>
                <h3 className="font-medium text-foreground flex items-center gap-2" data-testid="text-download-header">
                  <Database className="w-4 h-4" style={{ color: "var(--gold)" }} />
                  Download Full Backup
                </h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Exports all critical tables as a multi-sheet Excel workbook. Includes proposal log, users, projects, scopes, regions, vendors, products, notifications, and audit logs.
                </p>
                {backupInfo && (
                  <p className="text-xs text-muted-foreground mt-2" data-testid="text-backup-stats">
                    {backupInfo.tables.length} tables · {backupInfo.totalRows.toLocaleString()} total rows
                  </p>
                )}
              </div>
              <Button
                onClick={handleDownload}
                disabled={downloading}
                className="bg-gradient-to-r from-[var(--gold)] to-[var(--gold-light)] text-black font-medium shrink-0"
                data-testid="button-download-backup"
              >
                {downloading ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Download className="w-4 h-4 mr-2" />
                )}
                {downloading ? "Generating..." : "Download Backup"}
              </Button>
            </div>

            {infoLoading ? (
              <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-3 h-3 animate-spin" /> Loading table info...
              </div>
            ) : backupInfo ? (
              <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                {backupInfo.tables.map(t => (
                  <div
                    key={t.key}
                    className="flex items-center justify-between text-xs px-3 py-2 rounded-md border border-border bg-background"
                    data-testid={`text-table-info-${t.key}`}
                  >
                    <span className="text-foreground font-medium truncate">{t.label}</span>
                    <Badge variant="secondary" className="ml-2 shrink-0 text-[10px]">
                      {t.rowCount}
                    </Badge>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <div className="rounded-lg border border-border bg-card p-4">
            <h3 className="font-medium text-foreground flex items-center gap-2" data-testid="text-restore-header">
              <Upload className="w-4 h-4" style={{ color: "var(--gold)" }} />
              Restore from Backup
            </h3>
            <p className="text-sm text-muted-foreground mt-1">
              Upload a previously downloaded backup file to preview and validate its contents.
            </p>

            <div className="mt-4 flex items-center gap-3">
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx"
                onChange={handleFileSelect}
                className="hidden"
                data-testid="input-restore-file"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                data-testid="button-select-backup-file"
              >
                <Upload className="w-3.5 h-3.5 mr-1.5" />
                {restoreFile ? "Change File" : "Select Backup File"}
              </Button>
              {restoreFile && (
                <span className="text-sm text-foreground" data-testid="text-selected-file">
                  {restoreFile.name}
                  <span className="text-muted-foreground ml-2">
                    ({(restoreFile.size / 1024).toFixed(1)} KB)
                  </span>
                </span>
              )}
            </div>

            {restoreFile && (
              <div className="mt-4 space-y-3">
                <Label className="text-sm font-medium">Select tables to validate:</Label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {restorableTables.map(t => (
                    <label
                      key={t.key}
                      className={`flex items-center gap-2 text-sm px-3 py-2 rounded-md border cursor-pointer transition-colors ${
                        selectedTables.includes(t.key)
                          ? "border-[var(--gold)] bg-[var(--gold)]/10"
                          : "border-border bg-background hover:border-muted-foreground/30"
                      }`}
                      data-testid={`checkbox-restore-${t.key}`}
                    >
                      <input
                        type="checkbox"
                        checked={selectedTables.includes(t.key)}
                        onChange={() => toggleTable(t.key)}
                        className="accent-[var(--gold)]"
                      />
                      <span className="text-foreground">{t.label}</span>
                    </label>
                  ))}
                </div>

                <div className="flex items-center gap-2 pt-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handlePreview}
                    disabled={previewing || selectedTables.length === 0}
                    data-testid="button-preview-restore"
                  >
                    {previewing ? (
                      <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                    ) : (
                      <CheckCircle className="w-3.5 h-3.5 mr-1.5" />
                    )}
                    Validate Backup
                  </Button>
                </div>
              </div>
            )}

            {previewResult && (
              <div className="mt-4 rounded-md border border-border p-4 bg-background">
                <div className="flex items-center gap-2 mb-3">
                  <CheckCircle className="w-4 h-4 text-green-500" />
                  <span className="font-medium text-foreground text-sm" data-testid="text-preview-status">
                    {previewResult.message}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mb-3" data-testid="text-backup-date">
                  Backup date: {previewResult.backupDate}
                </p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Table</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Rows</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {previewResult.results?.map((r: any, i: number) => (
                      <TableRow key={i}>
                        <TableCell className="font-medium" data-testid={`text-restore-table-${i}`}>
                          {r.table}
                        </TableCell>
                        <TableCell>
                          <Badge variant={r.rowCount > 0 ? "default" : "secondary"} className="text-[10px]">
                            {r.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">{r.rowCount}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>

                <div className="mt-3 flex items-start gap-2 p-3 rounded-md bg-amber-500/10 border border-amber-500/20">
                  <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                  <p className="text-xs text-foreground">
                    This backup file has been validated and is intact. For data recovery, contact your system administrator with this file. Direct database restore is restricted to prevent accidental data loss.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
