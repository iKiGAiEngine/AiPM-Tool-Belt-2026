import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { BackNav } from "@/components/BackNav";
import { BackupRestoreSection } from "@/pages/AdminPage";

export default function AdminBackupPage() {
  return (
    <div className="min-h-[calc(100vh-4rem)] bg-background" data-testid="page-admin-backup">
      <div className="max-w-5xl mx-auto px-6 pt-6">
        <BackNav href="/admin" label="Admin Dashboard" testId="button-back-admin" />
      </div>
      <BackupRestoreSection />
    </div>
  );
}
