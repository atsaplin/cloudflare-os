import type { CommitInfo } from "@gadgets/workshop-shared/api";
import { WorkspaceRepository } from "../../src/workspace-repository";

interface Options {
  state: DurableObjectState;
  bucket: R2Bucket;
  workspaceId: string;
}

export function createArtifactsWorkspaceFiles(options: Options) {
  const repository = new WorkspaceRepository(options);
  return {
    initialize: repository.initialize.bind(repository),
    getRevision: repository.getRevision.bind(repository),
    list: repository.list.bind(repository),
    readFileStream: repository.readFileStream.bind(repository),
    stageUpload: repository.stageUpload.bind(repository),
    applyStaged: repository.applyStaged.bind(repository),
    getNextUploadExpiry: repository.getNextUploadExpiry.bind(repository),
    cleanupExpiredUploads: repository.cleanupExpiredUploads.bind(repository),
    deleteAllWorkspaceFiles: repository.deleteAllWorkspaceFiles.bind(repository),
    async getHistory(depth?: number): Promise<CommitInfo[]> {
      return (await repository.getHistory(depth)).map(commit => ({
        oid: commit.oid,
        parents: commit.parent,
        message: commit.message,
        author: {
          name: commit.author.name,
          email: commit.author.email,
        },
        timestamp: new Date(commit.author.timestamp * 1_000),
      }));
    },
  };
}
