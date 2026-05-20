import { Link } from "wouter";
import { Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BackNav } from "@/components/BackNav";
import { AdminUsersSection } from "@/pages/AdminPage";

export default function AdminUsersPage() {
  return (
    <div className="min-h-[calc(100vh-4rem)] bg-background" data-testid="page-admin-users">
      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <BackNav href="/admin" label="Admin Dashboard" testId="button-back-admin" />
            <Users className="w-5 h-5" style={{ color: "var(--gold)" }} />
            <h1 className="text-2xl font-heading font-semibold text-foreground" data-testid="text-admin-users-title">
              User Management
            </h1>
          </div>
          <p className="text-muted-foreground ml-12 text-sm">
            Add users, edit profiles, set temporary passwords, and manage active status.
          </p>
        </div>
        <AdminUsersSection />
      </div>
    </div>
  );
}
