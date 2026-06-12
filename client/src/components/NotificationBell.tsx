import { useState, useRef, useEffect } from "react";
import { Bell, Check, CheckCheck } from "lucide-react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { queryClient, apiRequest } from "@/lib/queryClient";

interface NotificationItem {
  id: number;
  type: string;
  title: string;
  message: string;
  metadata: Record<string, unknown> | null;
  isRead: boolean;
  createdAt: string;
}

interface NotificationsResponse {
  notifications: NotificationItem[];
  unreadCount: number;
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const [, navigate] = useLocation();

  const { data } = useQuery<NotificationsResponse>({
    queryKey: ["/api/notifications"],
    refetchInterval: 30000,
  });

  const markReadMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("PATCH", `/api/notifications/${id}/read`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
    },
  });

  const markAllReadMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/notifications/mark-all-read");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
    },
  });

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const unreadCount = data?.unreadCount || 0;
  const items = data?.notifications || [];

  const formatTime = (dateStr: string) => {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  };

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setOpen(!open)}
        className="relative p-2 rounded-md transition-colors"
        style={{ color: "var(--text-dim)" }}
        data-testid="button-notifications"
      >
        <Bell className="h-4 w-4" />
        {unreadCount > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 flex items-center justify-center h-4 min-w-4 px-1 text-[10px] font-bold rounded-full text-white"
            style={{ background: "#ef4444" }}
            data-testid="badge-notification-count"
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-2 w-80 rounded-lg shadow-lg z-50 overflow-hidden"
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--border-ds)",
          }}
        >
          <div className="flex items-center justify-between p-3" style={{ borderBottom: "1px solid var(--border-ds)" }}>
            <span className="text-sm font-heading font-semibold" style={{ color: "var(--text)" }}>
              Notifications
            </span>
            {unreadCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="text-xs h-7 gap-1"
                onClick={() => markAllReadMutation.mutate()}
                disabled={markAllReadMutation.isPending}
                data-testid="button-mark-all-read"
              >
                <CheckCheck className="h-3 w-3" />
                Mark all read
              </Button>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto">
            {items.length === 0 ? (
              <div className="p-6 text-center text-xs" style={{ color: "var(--text-dim)" }}>
                No notifications
              </div>
            ) : (
              items.map(item => (
                <div
                  key={item.id}
                  className="flex items-start gap-3 p-3 transition-colors cursor-pointer"
                  style={{
                    borderBottom: "1px solid var(--border-ds)",
                    background: item.isRead ? "transparent" : "rgba(201,168,76,0.05)",
                  }}
                  onClick={() => {
                    if (!item.isRead) markReadMutation.mutate(item.id);
                    setOpen(false);
                    navigate("/tools/proposal-log");
                  }}
                  data-testid={`notification-item-${item.id}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      {!item.isRead && (
                        <div className="h-2 w-2 rounded-full flex-shrink-0" style={{ background: "var(--gold)" }} />
                      )}
                      <span className="text-xs font-medium truncate" style={{ color: "var(--text)" }}>
                        {item.title}
                      </span>
                    </div>
                    <p className="text-xs mt-0.5 line-clamp-2" style={{ color: "var(--text-dim)" }}>
                      {item.message}
                    </p>
                    <span className="text-[10px] mt-1 block" style={{ color: "var(--text-dim)" }}>
                      {formatTime(item.createdAt)}
                    </span>
                  </div>
                  {!item.isRead && (
                    <button
                      className="flex-shrink-0 p-1 rounded hover:bg-white/10"
                      onClick={(e) => {
                        e.stopPropagation();
                        markReadMutation.mutate(item.id);
                      }}
                      title="Mark as read"
                    >
                      <Check className="h-3 w-3" style={{ color: "var(--text-dim)" }} />
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
