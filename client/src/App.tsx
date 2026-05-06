import { useEffect } from "react";
import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/lib/theme";
import { TestModeProvider } from "@/lib/testMode";
import { AuthProvider, useAuth } from "@/lib/auth";
import { useFeatureAccess } from "@/hooks/use-feature-access";
import { Header } from "@/components/Header";
import { Loader2 } from "lucide-react";
import HomePage from "@/pages/HomePage";
import PlanParserPage from "@/pages/PlanParserPage";
import CentralSettingsPage from "@/pages/CentralSettingsPage";
import QuoteParserPage from "@/pages/QuoteParserPage";
import ProjectStartPage from "@/pages/ProjectStartPage";
import ProjectDetailPage from "@/pages/ProjectDetailPage";
import ProjectLogPage from "@/pages/ProjectLogPage";
import ScheduleConverterPage from "@/pages/ScheduleConverterPage";
import SpecExtractorPage from "@/pages/SpecExtractorPage";
import LoginPage from "@/pages/LoginPage";
import ForgotPasswordPage from "@/pages/ForgotPasswordPage";
import ResetPasswordPage from "@/pages/ResetPasswordPage";
import ForcePasswordChangePage from "@/pages/ForcePasswordChangePage";
import AdminDashboardPage from "@/pages/AdminDashboardPage";
import AdminUsersPage from "@/pages/AdminUsersPage";
import AdminBackupPage from "@/pages/AdminBackupPage";
import AuditLogPage from "@/pages/AuditLogPage";
import SubmittalBuilderPage from "@/submittal-builder/SubmittalBuilderPage";
import VendorDatabasePage from "@/pages/VendorDatabasePage";
import { AdminUserPermissionsPage } from "@/pages/AdminUserPermissionsPage";
import ChangelogPage from "@/pages/ChangelogPage";
import ProposalChangeLogPage from "@/pages/ProposalChangeLogPage";
import EstimatingModulePage from "@/pages/EstimatingModulePage";
import AdminEstimatorAnalyticsPage from "@/pages/AdminEstimatorAnalyticsPage";
import AdminPortfolioVisitsPage from "@/pages/AdminPortfolioVisitsPage";
import HelpCenterPage from "@/pages/HelpCenterPage";
import NotFound from "@/pages/not-found";

const PUBLIC_PATHS = ["/forgot-password", "/reset-password"];

function AdminRoute({ component: Component }: { component: React.ComponentType }) {
  const { isAdmin, isLoading } = useAuth();
  if (isLoading) return null;
  if (!isAdmin) return <HomePage />;
  return <Component />;
}

function AdminDashboardRoute({ component: Component }: { component: React.ComponentType }) {
  const { canAccessAdminDashboard, isLoading } = useAuth();
  const [, setLocation] = useLocation();
  useEffect(() => {
    if (!isLoading && !canAccessAdminDashboard) {
      setLocation("/");
    }
  }, [isLoading, canAccessAdminDashboard, setLocation]);
  if (isLoading || !canAccessAdminDashboard) return null;
  return <Component />;
}

function SettingsRoute({ component: Component }: { component: React.ComponentType }) {
  const { isAdmin, isLoading } = useAuth();
  const { hasFeature, isLoading: featuresLoading } = useFeatureAccess();
  if (isLoading || featuresLoading) return null;
  if (!isAdmin && !hasFeature("central-settings") && !hasFeature("settings-regions")) return <HomePage />;
  return <Component />;
}

function BcSyncRoute({ component: Component }: { component: React.ComponentType }) {
  const { isAdmin, isLoading } = useAuth();
  const { hasFeature, isLoading: featuresLoading } = useFeatureAccess();
  if (isLoading || featuresLoading) return null;
  if (!isAdmin && !hasFeature("bc-sync")) return <HomePage />;
  return <Component />;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={HomePage} />
      <Route path="/home" component={HomePage} />
      <Route path="/planparser" component={PlanParserPage} />
      <Route path="/quoteparser" component={QuoteParserPage} />
      <Route path="/settings">{() => <SettingsRoute component={CentralSettingsPage} />}</Route>
      <Route path="/project-start" component={ProjectStartPage} />
      <Route path="/projects/:id" component={ProjectDetailPage} />
      <Route path="/tools/bc-sync-table">{() => <BcSyncRoute component={ProjectLogPage} />}</Route>
      <Route path="/project-log">{() => { window.location.replace("/tools/bc-sync-table"); return null; }}</Route>
      <Route path="/schedule-converter" component={ScheduleConverterPage} />
      <Route path="/spec-extractor" component={SpecExtractorPage} />
      <Route path="/admin">{() => <AdminDashboardRoute component={AdminDashboardPage} />}</Route>
      <Route path="/admin/users">{() => <AdminRoute component={AdminUsersPage} />}</Route>
      <Route path="/admin/feature-access">{() => <AdminRoute component={AdminUserPermissionsPage} />}</Route>
      <Route path="/admin/audit">{() => <AdminRoute component={AuditLogPage} />}</Route>
      <Route path="/admin/permissions">{() => <AdminRoute component={AdminUserPermissionsPage} />}</Route>
      <Route path="/admin/proposal-change-log">{() => <AdminRoute component={ProposalChangeLogPage} />}</Route>
      <Route path="/admin/estimator-analytics">{() => <AdminRoute component={AdminEstimatorAnalyticsPage} />}</Route>
      <Route path="/admin/backup">{() => <AdminRoute component={AdminBackupPage} />}</Route>
      <Route path="/admin/portfolio-visits">{() => <AdminRoute component={AdminPortfolioVisitsPage} />}</Route>
      <Route path="/admin/changelog">{() => <AdminRoute component={ChangelogPage} />}</Route>
      <Route path="/changelog">{() => <AdminRoute component={ChangelogPage} />}</Route>
      <Route path="/submittal-builder" component={SubmittalBuilderPage} />
      <Route path="/vendor-database" component={VendorDatabasePage} />
      <Route path="/estimates/:id" component={EstimatingModulePage} />
      <Route path="/help-center" component={HelpCenterPage} />
      <Route path="/help-center/:sop" component={HelpCenterPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function AuthGate() {
  const { isAuthenticated, isLoading, mustChangePassword } = useAuth();
  const [location] = useLocation();

  const isPublicPath = PUBLIC_PATHS.some(p => location.startsWith(p));

  if (isPublicPath) {
    return (
      <Switch>
        <Route path="/forgot-password" component={ForgotPasswordPage} />
        <Route path="/reset-password" component={ResetPasswordPage} />
      </Switch>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  if (mustChangePassword) {
    return <ForcePasswordChangePage />;
  }

  return (
    <TestModeProvider>
      <div className="min-h-screen bg-background">
        <Header />
        <Router />
      </div>
    </TestModeProvider>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <AuthProvider>
            <AuthGate />
          </AuthProvider>
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
