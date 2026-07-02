// Statuses that represent a concluded bid decision.
// These must not be overwritten by automated processes such as the Google Sheet sync
// or the proposal total auto-derive logic in the PATCH route.
// Keep this list in sync with the status options available in ProposalLogPage.tsx.
export const TERMINAL_ESTIMATE_STATUSES = [
  "Won",
  "Lost",
  "Lost - Note Why in Comments",
  "No Bid",
];
