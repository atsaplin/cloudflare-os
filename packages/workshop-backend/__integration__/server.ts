import { setArtifactsWorkspaceFilesFactoryForTest } from "../src/artifacts-workspace-files";
import { createArtifactsWorkspaceFiles } from "./support/artifacts-workspace-files";

setArtifactsWorkspaceFilesFactoryForTest(createArtifactsWorkspaceFiles);

export { default } from "../src/server";
export * from "../src/server";
