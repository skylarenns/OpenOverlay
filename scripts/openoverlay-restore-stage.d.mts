export interface SnapshotMediaFile {
  rowId: string;
  kind: "original" | "thumbnail";
  backupName: string;
  byteSize: number;
  sha256: string;
}

export function stageRestore(
  snapshot: string,
  manifest: { media: SnapshotMediaFile[] },
  directory: string,
  targetUploadDir?: string
): Promise<{ databasePath: string; stagedUploadDir: string }>;
