type ToastFn = (opts: { title: string; description?: string; variant?: "default" | "destructive" | null }) => void;

/**
 * Guards a write action for viewer-role users.
 * Returns true when blocked (caller should return early), false when allowed.
 */
export function guardViewer(isViewer: boolean, toast: ToastFn): boolean {
  if (!isViewer) return false;
  toast({
    title: "Read-only access",
    description: "Viewer accounts cannot make changes.",
    variant: "destructive",
  });
  return true;
}
