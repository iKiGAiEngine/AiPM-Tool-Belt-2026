import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";

export function useFeatureAccess() {
  const { user, isAdmin } = useAuth();

  const { data: features = [], isLoading } = useQuery({
    queryKey: ["/api/user/features", user?.id ?? null],
    queryFn: async () => {
      const res = await fetch("/api/user/features");
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
  });

  const hasFeature = (feature: string): boolean => {
    return features.includes(feature);
  };

  const canReviewDrafts: boolean = !!isAdmin || hasFeature("draft-review");

  return { features, hasFeature, canReviewDrafts, isLoading };
}
