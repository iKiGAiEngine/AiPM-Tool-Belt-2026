// =====================================================
// SUBMITTAL BUILDER — package validation
// =====================================================
//
// Issues are GROUPED per scope per kind. The previous version emitted one issue
// per line, so a routine 60-line scope produced 180 warnings and the panel
// truncated at 20 — an unreadable wall that told the PM nothing. Each group
// carries the affected line ids so the UI can jump straight to them.
//
// Only things that genuinely stop a package going out are errors. A blank
// callout is common and harmless in real estimates and is a warning, not a
// blocker.

import type { Scope, ScheduleLine, SubmittalProject } from "./types";
import { isLineExcluded } from "./types";
import { totalPackagePages } from "./pagination";

export type Severity = "error" | "warning" | "info";

export interface ValidationIssue {
  /** Stable id so the UI can keep a group expanded across re-renders. */
  id: string;
  kind: string;
  severity: Severity;
  scopeId: string;
  /** Scope tab name, blank for project-level issues. */
  scope: string;
  msg: string;
  /** What the PM should do about it. */
  hint?: string;
  count: number;
  /** Lines this group covers, for jump-to-line. */
  lineIds: string[];
}

export interface ValidationSummary {
  totalScopes: number;
  totalLines: number;
  attached: number;
  excluded: number;
  missing: number;
  blankCallout: number;
  blankDesc: number;
  blankModel: number;
  zeroQty: number;
  totalAttPages: number;
  projectedPages: number;
}

export interface ValidationResult {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  info: ValidationIssue[];
  /** Everything, most severe first. */
  issues: ValidationIssue[];
  /** Count of issues that block export. */
  blockers: number;
  /** True when the package is complete and has no blockers. */
  ready: boolean;
  summary: ValidationSummary;
}

function emptySummary(): ValidationSummary {
  return {
    totalScopes: 0, totalLines: 0, attached: 0, excluded: 0, missing: 0,
    blankCallout: 0, blankDesc: 0, blankModel: 0, zeroQty: 0,
    totalAttPages: 0, projectedPages: 0,
  };
}

const blank = (v: unknown) => !String(v ?? "").trim();

/** Collects line ids per issue kind for one scope. */
class ScopeIssues {
  private groups = new Map<string, string[]>();
  constructor(private scope: Scope) {}

  add(kind: string, lineId: string) {
    const list = this.groups.get(kind);
    if (list) list.push(lineId);
    else this.groups.set(kind, [lineId]);
  }

  count(kind: string): number {
    return this.groups.get(kind)?.length ?? 0;
  }

  emit(kind: string, severity: Severity, msg: (n: number) => string, hint?: string): ValidationIssue | null {
    const lineIds = this.groups.get(kind);
    if (!lineIds || lineIds.length === 0) return null;
    return {
      id: `${this.scope.id}:${kind}`,
      kind,
      severity,
      scopeId: this.scope.id,
      scope: this.scope.tabName,
      msg: msg(lineIds.length),
      hint,
      count: lineIds.length,
      lineIds,
    };
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function validateProject(project: SubmittalProject | null | undefined): ValidationResult {
  const scopes = project?.scopes ?? [];
  const summary = emptySummary();
  const issues: ValidationIssue[] = [];

  summary.totalScopes = scopes.length;

  if (scopes.length === 0) {
    issues.push({
      id: "project:no_scopes", kind: "no_scopes", severity: "error", scopeId: "", scope: "",
      msg: "No scopes imported yet",
      hint: "Import an estimate workbook to start the package.",
      count: 1, lineIds: [],
    });
  }

  for (const scope of scopes) {
    const lines: ScheduleLine[] = scope.lines ?? [];
    const g = new ScopeIssues(scope);
    const callouts = new Map<string, number>();
    const models = new Map<string, number>();

    if (lines.length === 0) {
      issues.push({
        id: `${scope.id}:no_lines`, kind: "no_lines", severity: "error",
        scopeId: scope.id, scope: scope.tabName,
        msg: "No line items in this scope",
        hint: "Add lines by hand, or re-import the estimate workbook.",
        count: 1, lineIds: [],
      });
    }

    if (!scope.coverLines || scope.coverLines.length === 0) {
      issues.push({
        id: `${scope.id}:no_cover_rows`, kind: "no_cover_rows", severity: "warning",
        scopeId: scope.id, scope: scope.tabName,
        msg: "Cover page has no rows",
        hint: "Open Cover Page and use Auto-generate from pages.",
        count: 1, lineIds: [],
      });
    }

    for (const line of lines) {
      summary.totalLines++;

      for (const att of line.attachments ?? []) {
        summary.totalAttPages += att.pageCount || 0;
      }

      // Excluded lines are finished work — they are not missing anything and
      // must not drag the package's quality metrics down.
      if (isLineExcluded(line)) {
        summary.excluded++;
        g.add("excluded", line.id);
        continue;
      }

      if ((line.attachments?.length ?? 0) > 0) {
        summary.attached++;
      } else {
        summary.missing++;
        g.add("missing_product_data", line.id);
      }

      if (blank(line.callout)) {
        summary.blankCallout++;
        g.add("blank_callout", line.id);
      } else {
        const key = String(line.callout).trim();
        callouts.set(key, (callouts.get(key) ?? 0) + 1);
      }

      if (blank(line.desc)) {
        summary.blankDesc++;
        g.add("blank_desc", line.id);
      }

      if (blank(line.model)) {
        summary.blankModel++;
        g.add("blank_model", line.id);
      } else {
        const key = String(line.model).trim();
        models.set(key, (models.get(key) ?? 0) + 1);
      }

      const qty = Number(line.qty);
      if (!line.qty || !Number.isFinite(qty) || qty === 0) {
        summary.zeroQty++;
        g.add("zero_qty", line.id);
      }
    }

    const groups: Array<ValidationIssue | null> = [
      g.emit("blank_desc", "error", (n) => `${plural(n, "line has", "lines have")} no description`,
        "A schedule row cannot print without a description."),
      g.emit("missing_product_data", "warning", (n) => `${plural(n, "line is", "lines are")} waiting on product data`,
        "Attach a PDF, or mark the line Not Required / By Others."),
      g.emit("blank_model", "warning", (n) => `${plural(n, "line has", "lines have")} no model number`,
        "The GC matches submittals by model number."),
      g.emit("zero_qty", "warning", (n) => `${plural(n, "line has", "lines have")} no quantity`),
      g.emit("blank_callout", "warning", (n) => `${plural(n, "line has", "lines have")} no callout`,
        "Callouts are what gets stamped on the product data sheets."),
      g.emit("excluded", "info", (n) => `${plural(n, "line is", "lines are")} marked Not Required or By Others`),
    ];
    for (const issue of groups) {
      if (issue) issues.push(issue);
    }

    const dupCallouts = Array.from(callouts.entries()).filter(([, n]) => n > 1);
    if (dupCallouts.length > 0) {
      issues.push({
        id: `${scope.id}:duplicate_callout`, kind: "duplicate_callout", severity: "info",
        scopeId: scope.id, scope: scope.tabName,
        msg: `Repeated callout${dupCallouts.length === 1 ? "" : "s"}: ${dupCallouts.map(([k, n]) => `${k} (${n}x)`).join(", ")}`,
        count: dupCallouts.length, lineIds: [],
      });
    }
    const dupModels = Array.from(models.entries()).filter(([, n]) => n > 1);
    if (dupModels.length > 0) {
      issues.push({
        id: `${scope.id}:duplicate_model`, kind: "duplicate_model", severity: "info",
        scopeId: scope.id, scope: scope.tabName,
        msg: `Repeated model${dupModels.length === 1 ? "" : "s"}: ${dupModels.map(([k, n]) => `${k} (${n}x)`).join(", ")}`,
        hint: "One product data sheet can cover every line that uses it.",
        count: dupModels.length, lineIds: [],
      });
    }
  }

  summary.projectedPages = totalPackagePages(scopes);

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const info = issues.filter((i) => i.severity === "info");

  return {
    errors,
    warnings,
    info,
    issues: [...errors, ...warnings, ...info],
    blockers: errors.length,
    ready: errors.length === 0 && summary.missing === 0 && summary.totalLines > 0,
    summary,
  };
}
