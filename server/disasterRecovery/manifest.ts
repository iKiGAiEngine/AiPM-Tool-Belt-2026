/**
 * Disaster Recovery — the manifest (packing list) written into every backup as manifest.json.
 * The restore script reads it to know what to load and to verify nothing is damaged.
 */
import type { ColumnInfo, SequenceState } from "./databaseSnapshot";

export const MANIFEST_FORMAT_VERSION = 1;

export interface ManifestFile {
  path: string;   // relative to the backup folder, forward slashes
  bytes: number;
  sha256: string;
}

export interface BackupManifest {
  formatVersion: number;
  backupId: string;          // also the folder name, e.g. 2026-11-05_0900Z
  createdAt: string;         // ISO time the backup started
  completedAt: string;
  application: {
    name: "AiPM Tool Belt";
    gitCommit: string;
    gitBranch: string;
    nodeVersion: string;
    hostEnvironment: string;
  };
  database: {
    folder: string;          // "1_Database"
    serverVersion: string;
    databaseName: string;
    snapshotTakenAt: string;
    totalRows: number;
    tables: {
      table: string;
      rowCount: number;
      dataSkipped: boolean;
      skipReason?: string;
      file?: string;         // relative to the database folder
      columns: ColumnInfo[];
    }[];
    sequences: SequenceState[];
    pgDumpIncluded: boolean;
  };
  serverFiles: { included: boolean; file?: string; fileCount: number; note?: string };
  sourceCode: { included: boolean; file?: string; fileCount: number; note?: string };
  files: ManifestFile[];
  totalBytes: number;
  warnings: string[];
}
