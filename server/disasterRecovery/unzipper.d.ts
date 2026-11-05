// Minimal typings for the parts of "unzipper" used by the disaster-recovery restore.
declare module "unzipper" {
  interface CentralDirectory {
    files: { path: string; type: "File" | "Directory" }[];
    extract(opts: { path: string; concurrency?: number }): Promise<void>;
  }
  export const Open: { file(path: string): Promise<CentralDirectory> };
}
