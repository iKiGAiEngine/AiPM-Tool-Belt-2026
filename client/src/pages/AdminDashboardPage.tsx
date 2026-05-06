import { useLocation } from "wouter";
import {
  ShieldCheck,
  ScrollText,
  Users,
  ClipboardList,
  BarChart3,
  AlertOctagon,
  MessageSquare,
  Activity,
  FolderPlus,
  LayoutDashboard,
  KeyRound,
  HardDrive,
  BookOpen,
} from "lucide-react";

const PLAYFAIR = "'Playfair Display', serif";
const RAJDHANI = "'Rajdhani', sans-serif";

const ADMIN_TOOLS = [
  { href: "/admin/users", label: "Users", icon: Users, testId: "link-admin-tool-users" },
  { href: "/admin/feature-access", label: "Feature Access", icon: KeyRound, testId: "link-admin-tool-feature-access" },
  { href: "/admin/audit", label: "Audit Log", icon: ScrollText, testId: "link-admin-tool-audit" },
  { href: "/admin/permissions", label: "Permissions", icon: ShieldCheck, testId: "link-admin-tool-permissions" },
  { href: "/admin/proposal-change-log", label: "Proposal Change Log", icon: ClipboardList, testId: "link-admin-tool-proposal-change-log" },
  { href: "/admin/estimator-analytics", label: "Estimator Analytics", icon: BarChart3, testId: "link-admin-tool-estimator-analytics" },
  { href: "/admin/backup", label: "Database Backup", icon: HardDrive, testId: "link-admin-tool-backup" },
  { href: "/admin/changelog", label: "Changelog", icon: BookOpen, testId: "link-admin-tool-changelog" },
];

const SECTIONS = [
  {
    id: "command-center",
    title: "Today's Command Center",
    icon: LayoutDashboard,
    blurb: "At-a-glance summary of the day — coming soon.",
    testId: "section-command-center",
  },
  {
    id: "system-issues",
    title: "System Issues",
    icon: AlertOctagon,
    blurb: "Captured runtime errors, grouped by type and endpoint — coming soon.",
    testId: "section-system-issues",
  },
  {
    id: "chatbot-requests",
    title: "Chatbot Requests",
    icon: MessageSquare,
    blurb: "User feedback and bug reports submitted via the support chatbot — coming soon.",
    testId: "section-chatbot-requests",
  },
  {
    id: "chatbot-usage-report",
    title: "Chatbot Usage Report",
    icon: Activity,
    blurb: "Daily volume, response times, and topic mix — coming soon.",
    testId: "section-chatbot-usage-report",
  },
  {
    id: "new-projects-monitor",
    title: "New Projects Monitor",
    icon: FolderPlus,
    blurb: "Recently created projects and proposal-log entries — coming soon.",
    testId: "section-new-projects-monitor",
  },
];

function AdminToolButton({
  href,
  label,
  icon: Icon,
  testId,
}: {
  href: string;
  label: string;
  icon: typeof ShieldCheck;
  testId: string;
}) {
  const [, setLocation] = useLocation();
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={() => setLocation(href)}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-sm transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--gold-light)]"
      style={{
        color: "#e6d8a8",
        border: "1px solid transparent",
        background: "transparent",
        fontFamily: RAJDHANI,
        cursor: "pointer",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "var(--border-gold)";
        e.currentTarget.style.background = "rgba(168,137,46,0.08)";
        e.currentTarget.style.color = "var(--gold-light)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "transparent";
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = "#e6d8a8";
      }}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

export default function AdminDashboardPage() {
  return (
    <div
      className="min-h-screen w-full"
      style={{
        background: "#000",
        color: "#f5f5f5",
        fontFamily: RAJDHANI,
      }}
      data-testid="page-admin-dashboard"
    >
      <div className="max-w-7xl mx-auto px-6 py-10">
        <header className="flex items-center gap-3 mb-2">
          <ShieldCheck className="h-7 w-7" style={{ color: "var(--gold-light)" }} />
          <h1
            className="text-4xl tracking-wide"
            style={{
              fontFamily: PLAYFAIR,
              color: "var(--gold-light)",
              letterSpacing: "0.02em",
            }}
            data-testid="text-admin-dashboard-title"
          >
            Admin Dashboard
          </h1>
        </header>
        <p
          className="text-sm mb-8"
          style={{ color: "rgba(245,245,245,0.6)", fontFamily: RAJDHANI }}
          data-testid="text-admin-dashboard-subtitle"
        >
          Executive command center — monitor system health, support requests, and project activity.
        </p>

        <nav
          className="flex flex-wrap items-center gap-2 mb-10 px-3 py-2 rounded-md"
          style={{
            border: "1px solid var(--border-gold)",
            background: "rgba(168,137,46,0.04)",
            fontFamily: RAJDHANI,
          }}
          data-testid="nav-admin-tools"
        >
          <span
            className="text-xs uppercase tracking-widest pr-3"
            style={{ color: "var(--text-gold)", letterSpacing: "0.18em" }}
          >
            Admin Tools
          </span>
          <div className="flex flex-wrap gap-1">
            {ADMIN_TOOLS.map((tool) => (
              <AdminToolButton key={tool.href} {...tool} />
            ))}
          </div>
        </nav>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {SECTIONS.map(({ id, title, icon: Icon, blurb, testId }) => (
            <section
              key={id}
              className="rounded-md p-6"
              style={{
                background: "linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0))",
                border: "1px solid var(--border-gold)",
                boxShadow: "var(--shadow-gold)",
              }}
              data-testid={testId}
            >
              <div
                className="h-px w-12 mb-4"
                style={{ background: "linear-gradient(90deg, var(--gold-dim), var(--gold))" }}
              />
              <div className="flex items-center gap-3 mb-3">
                <Icon className="h-5 w-5" style={{ color: "var(--gold-light)" }} />
                <h2
                  className="text-2xl"
                  style={{
                    fontFamily: PLAYFAIR,
                    color: "var(--gold-light)",
                    letterSpacing: "0.01em",
                  }}
                  data-testid={`heading-${id}`}
                >
                  {title}
                </h2>
              </div>
              <p
                className="text-sm leading-relaxed"
                style={{ color: "rgba(245,245,245,0.55)", fontFamily: RAJDHANI }}
                data-testid={`placeholder-${id}`}
              >
                {blurb}
              </p>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
