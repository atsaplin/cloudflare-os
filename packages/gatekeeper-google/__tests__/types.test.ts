/// <reference types="node" />

import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../src");

function sourcePath(name: string): string {
  return join(SOURCE_DIR, name);
}

function source(name: string): string {
  return readFileSync(sourcePath(name), "utf8");
}

describe("embedded agent declarations", () => {
  for (const name of ["docs-read-types", "docs-types"]) {
    it(`keeps ${name}.txt linked to its TypeScript declaration`, () => {
      const textUrl = sourcePath(`${name}.txt`);
      expect(lstatSync(textUrl).isSymbolicLink()).toBe(true);
      expect(readlinkSync(textUrl)).toBe(`${name}.d.ts`);
      expect(source(`${name}.txt`)).toBe(source(`${name}.d.ts`));
    });
  }

  it("keeps the Drive declaration aligned after module-only imports", () => {
    const modulePrefix =
      'import type { GoogleDocReadSession } from "./docs-read-types";\n' +
      'import type { GoogleSpreadsheetSession } from "./sheets-types";\n\n';
    const driveTypes = source("drive-types.d.ts");
    expect(driveTypes.startsWith(modulePrefix)).toBe(true);
    expect(source("drive-types.txt")).toBe(driveTypes.slice(modulePrefix.length));
  });

  it("keeps Drive Docs authority read-only", () => {
    const readTypes = source("docs-read-types.d.ts");
    expect(readTypes).toContain("export interface GoogleDocReadSession");
    expect(readTypes).not.toContain("replaceText");
    expect(readTypes).not.toContain("appendText");
    expect(source("docs-types.d.ts")).toContain(
      "export interface GoogleDocSession extends GoogleDocReadSession",
    );
  });

  it("exposes only typed native content sessions from Drive", () => {
    const driveTypes = source("drive-types.d.ts");
    expect(driveTypes).toContain(
      "openGoogleDoc(fileId: string): Promise<GoogleDocReadSession>",
    );
    expect(driveTypes).toContain(
      "openGoogleSheet(fileId: string): Promise<GoogleSpreadsheetSession>",
    );
    expect(driveTypes).not.toContain("GoogleDocSession>");
  });
});
