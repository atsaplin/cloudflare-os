import { setArtifactsWorkspaceFilesFactoryForTest } from "../src/artifacts-workspace-files";
import { setWorkspaceCodeRepositoryFactoryForTest } from "../src/overseer";
import {
  createArtifactsWorkspaceFiles,
  createWorkspaceCodeRepository,
} from "./support/artifacts-workspace-files";

setArtifactsWorkspaceFilesFactoryForTest(createArtifactsWorkspaceFiles);
setWorkspaceCodeRepositoryFactoryForTest(
  (_repository, workspaceId) => createWorkspaceCodeRepository(workspaceId),
);

export { default } from "../src/server";
export * from "../src/server";
