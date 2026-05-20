import { useAuth } from "@/lib/auth";

export function ReadOnlyBanner() {
  const { isViewer } = useAuth();
  if (!isViewer) return null;
  return (
    <div
      data-testid="banner-read-only"
      className="fixed top-3 left-3 z-[100] flex items-center gap-2 px-3 py-1.5 bg-amber-500/95 border border-amber-600 text-amber-950 text-xs font-medium rounded-md shadow-md pointer-events-none"
    >
      <span>⚠</span>
      <span>Read-only access — you can view all data but changes cannot be saved.</span>
    </div>
  );
}
