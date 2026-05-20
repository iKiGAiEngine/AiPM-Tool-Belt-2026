import { useAuth } from "@/lib/auth";

export function ReadOnlyBanner() {
  const { isViewer } = useAuth();
  if (!isViewer) return null;
  return (
    <div
      data-testid="banner-read-only"
      className="fixed bottom-0 left-0 right-0 z-[100] flex items-center justify-center gap-2 px-4 py-2 bg-amber-500/95 border-t border-amber-600 text-amber-950 text-sm font-medium shadow-md pointer-events-none"
    >
      <span>⚠</span>
      <span>Read-only access — you can view all data but changes cannot be saved.</span>
    </div>
  );
}
