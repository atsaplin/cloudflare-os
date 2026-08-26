import { describe, expect, it } from "vitest";
import { FolderOpen } from "@phosphor-icons/react";
import type { AiToolCall } from "@gadgets/workshop-shared/api";
import {
  buildProvisionalToolSummary,
  buildToolCallGroups,
  describeProvisionalToolCount,
  getProvisionalToolLabel,
  getToolCallSummary,
  getToolIcon,
} from "./ChatInterface";

type WorkspaceFileInput = Extract<AiToolCall, { toolName: "workspaceFiles" }>["input"];

function workspaceCall(input: WorkspaceFileInput, toolCallId = "workspace-call"):
  Extract<AiToolCall, { toolName: "workspaceFiles" }> {
  return { toolCallId, toolName: "workspaceFiles", input };
}

describe("workspace file tool transcript labels", () => {
  it.each([
    [{ action: "list", path: "/src" }, { verb: "Listed", target: "/src" }],
    [{ action: "read", path: "/src/index.ts" }, { verb: "Read", target: "/src/index.ts" }],
    [{ action: "write", path: "/src/index.ts", content: "" }, { verb: "Wrote", target: "/src/index.ts" }],
    [{ action: "mkdir", path: "/src" }, { verb: "Created folder", target: "/src" }],
    [{ action: "move", path: "/src/a.ts", destination: "/src/b.ts" },
      { verb: "Moved", target: "/src/a.ts → /src/b.ts" }],
    [{ action: "delete", path: "/src/a.ts" }, { verb: "Deleted", target: "/src/a.ts" }],
  ] as const)("summarizes %s", (input, expected) => {
    expect(getToolCallSummary(workspaceCall(input))).toEqual(expected);
  });

  it("uses the workspace folder icon", () => {
    expect(getToolIcon("workspaceFiles")).toBe(FolderOpen);
  });

  it("groups mixed workspace operations by action", () => {
    const groups = buildToolCallGroups([
      workspaceCall({ action: "read", path: "/README.md" }, "read"),
      workspaceCall({ action: "write", path: "/src/app.ts", content: "" }, "write"),
      workspaceCall({ action: "delete", path: "/tmp.txt" }, "delete"),
    ]);

    expect(groups[0]?.label).toBe("Read 1 workspace file, wrote 1 workspace file, deleted 1 workspace item");
  });
});

describe("workspace file provisional labels", () => {
  it("names the workspace tool while its operation is streaming", () => {
    expect(getProvisionalToolLabel("workspaceFiles")).toBe("Working with workspace files");
    expect(describeProvisionalToolCount("workspaceFiles", 2)).toBe("Working with 2 workspace operations");
  });

  it("keeps a workspace target in the provisional summary when one is available", () => {
    expect(buildProvisionalToolSummary([{
      toolCallId: "workspace-call",
      toolName: "workspaceFiles",
      target: "/src",
      code: "",
      output: "",
      finished: false,
    }])).toEqual({ label: "Working with /src", detailLines: [] });
  });
});
