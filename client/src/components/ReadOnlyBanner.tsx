import { useAuth } from "@/lib/auth";

export function ReadOnlyBanner() {
  const { isViewer } = useAuth();
  if (!isViewer) return null;
  return (
    <div
      data-testid="banner-read-only"
      className="w-full flex items-center gap-2 px-4 py-2 bg-amber-500/15 border border-amber-500/30 text-amber-700 dark:text-amber-400 text-sm font-medium rounded-md mb-4"
    >
      <span>⚠</span>
      <span>Read-only access — you can view all data but changes cannot be saved.</span>
    </div>
  );
}
