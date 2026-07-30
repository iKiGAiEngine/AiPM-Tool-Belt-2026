// The submittal package types now live in shared/ so the client, the server
// routes and the PDF builder all agree on one shape.
export type {
  Attachment,
  ScheduleLine,
  CoverLine,
  Scope,
  SubmittalPackage,
  SubmittalProject,
  ProposalLogEntry,
  LineStatus,
  SubmittalStatus,
  MatchStatus,
  CoverRowType,
  Progress,
} from "@shared/submittal/types";

export {
  isLineResolved,
  isLineExcluded,
  scopeProgress,
  packageProgress,
  derivePackageStatus,
} from "@shared/submittal/types";
