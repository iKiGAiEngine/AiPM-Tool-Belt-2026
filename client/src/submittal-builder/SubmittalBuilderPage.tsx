import { useState, useCallback } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listProjects, createProject, deleteProject, readableError } from "./api";
import { todayCoverDate } from "./helpers";
import Dashboard from "./Dashboard";
import NewProject from "./NewProject";
import Workspace from "./Workspace";
import type { ProposalLogEntry, SubmittalProject } from "@shared/submittal/types";

type View = "dashboard" | "new" | { workspace: string };

const FLASH_STYLES: Record<string, React.CSSProperties> = {
  success: { background: "var(--success)", color: "#fff" },
  error: { background: "var(--error)", color: "#fff" },
  info: { background: "var(--text-primary)", color: "var(--bg-card)" },
};

const QUERY_KEY = ["/api/submittal/projects"];

export default function SubmittalBuilderPage() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>("dashboard");
  const [flashMsg, setFlashMsg] = useState<{ msg: string; type: string } | null>(null);

  const { data: projects = [], isLoading, error } = useQuery<SubmittalProject[]>({
    queryKey: QUERY_KEY,
    queryFn: listProjects,
  });

  const refreshProjects = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  }, [queryClient]);

  const flash = useCallback((msg: string, type = "info") => {
    setFlashMsg({ msg, type });
    // Errors stay up long enough to actually read.
    setTimeout(() => setFlashMsg(null), type === "error" ? 7000 : 3500);
  }, []);

  const handleCreate = useCallback(async (entry: ProposalLogEntry) => {
    try {
      const created = await createProject({
        proposalLogId: entry.id,
        projectName: entry.projectName,
        gc: entry.gcEstimateLead || "",
        assignedPm: entry.nbsEstimator || "",
        coverDate: todayCoverDate(),
        estimateNumber: entry.estimateNumber ?? null,
        region: entry.region ?? null,
      });
      refreshProjects();
      setView({ workspace: created.id });
      flash("Submittal created — import the estimate workbook next", "success");
    } catch (err) {
      flash(readableError(err, "Could not create the submittal"), "error");
    }
  }, [flash, refreshProjects]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await deleteProject(id);
      refreshProjects();
      flash("Submittal deleted", "info");
    } catch (err) {
      flash(readableError(err, "Could not delete the submittal"), "error");
    }
  }, [flash, refreshProjects]);

  return (
    <div style={{ position: "relative" }}>
      {flashMsg && (
        <div
          role="status" aria-live="polite"
          data-testid="toast-flash"
          style={{
            position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
            padding: "10px 22px", borderRadius: 8, fontSize: 13, fontWeight: 600,
            zIndex: 9999, boxShadow: "0 4px 24px rgba(0,0,0,.35)", maxWidth: "80vw",
            ...(FLASH_STYLES[flashMsg.type] ?? FLASH_STYLES.info),
          }}
        >
          {flashMsg.msg}
        </div>
      )}

      {view === "dashboard" && (
        <Dashboard
          projects={projects}
          loading={isLoading}
          error={error ? readableError(error, "Could not load submittals") : null}
          onOpen={(id) => setView({ workspace: id })}
          onNew={() => setView("new")}
          onDelete={handleDelete}
          onBack={() => navigate("/")}
        />
      )}

      {view === "new" && (
        <NewProject onBack={() => setView("dashboard")} onCreate={handleCreate} />
      )}

      {typeof view === "object" && "workspace" in view && (
        <Workspace
          projectId={view.workspace}
          onHome={() => { setView("dashboard"); refreshProjects(); }}
          flash={flash}
          refreshProjects={refreshProjects}
        />
      )}
    </div>
  );
}
