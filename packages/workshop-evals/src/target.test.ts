import { describe, expect, it } from "vitest";
import { resolveWorkshopTarget } from "./target.js";

describe("resolveWorkshopTarget", () => {
  it("uses an Access-authenticated preview when a target URL is configured", () => {
    expect(resolveWorkshopTarget({
      WORKSHOP_EVAL_TARGET: "https://preview.example.com",
      CF_ACCESS_TOKEN: "access-token",
    })).toEqual({
      kind: "preview",
      url: new URL("https://preview.example.com"),
      accessToken: "access-token",
    });
  });

  it("requires an Access token for a preview", () => {
    expect(() => resolveWorkshopTarget({
      WORKSHOP_EVAL_TARGET: "https://preview.example.com",
    })).toThrow("CF_ACCESS_TOKEN");
  });

  it("uses the existing AI Gateway configuration for local workerd", () => {
    expect(resolveWorkshopTarget({
      CF_AI_GATEWAY: "gateway",
      CF_AI_GATEWAY_ACCOUNT_ID: "account",
      CF_AI_GATEWAY_API_TOKEN: "token",
    })).toEqual({
      kind: "local",
      modelAccess: {
        kind: "gateway",
        gateway: "gateway",
        accountId: "account",
        apiToken: "token",
      },
    });
  });

  it("uses existing Cloudflare credentials for direct local Workers AI", () => {
    expect(resolveWorkshopTarget({
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "token",
    })).toEqual({
      kind: "local",
      modelAccess: { kind: "direct", accountId: "account", apiToken: "token" },
    });
  });

  it("fails clearly when local workerd has no model credentials", () => {
    expect(() => resolveWorkshopTarget({})).toThrow("model credentials");
  });
});
