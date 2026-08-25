import { describe, expect, it, vi } from "vitest";
import { loadCodeModeWorker } from "../src/overseer.js";

describe("loadCodeModeWorker", () => {
  it("loads directly when no gadget can own persistent callbacks", async () => {
    let loadDirect = vi.fn(() => "direct");
    let loadRestored = vi.fn(async (_gadgetId: number) => "restored");

    await expect(loadCodeModeWorker(undefined, loadDirect, loadRestored))
        .resolves.toBe("direct");
    expect(loadDirect).toHaveBeenCalledOnce();
    expect(loadRestored).not.toHaveBeenCalled();
  });

  it("loads through gadget restoration when a callback owner exists", async () => {
    let loadDirect = vi.fn(() => "direct");
    let loadRestored = vi.fn(async (_gadgetId: number) => "restored");

    await expect(loadCodeModeWorker(17, loadDirect, loadRestored))
        .resolves.toBe("restored");
    expect(loadDirect).not.toHaveBeenCalled();
    expect(loadRestored).toHaveBeenCalledExactlyOnceWith(17);
  });
});
