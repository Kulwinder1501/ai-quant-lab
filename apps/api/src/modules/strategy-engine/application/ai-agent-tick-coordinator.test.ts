import { describe, expect, it, vi } from "vitest";
import { AiAgentTickCoordinator, type AiAgentTicker } from "./ai-agent-tick-coordinator.js";

describe("AiAgentTickCoordinator", () => {
  it("coalesces concurrent ticks for the same symbol and timeframe", async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent: AiAgentTicker = { tick: vi.fn(() => pending) };
    const coordinator = new AiAgentTickCoordinator(1_000, () => 10_000);

    const first = coordinator.run(agent, "NIFTY50", "1d", 24_500);
    const duplicate = coordinator.run(agent, "nifty50", "1D", 24_501);
    await Promise.resolve();

    expect(agent.tick).toHaveBeenCalledTimes(1);
    release?.();
    await expect(Promise.all([first, duplicate])).resolves.toEqual([true, false]);
  });

  it("throttles completed ticks while allowing independent streams", async () => {
    let now = 10_000;
    const agent: AiAgentTicker = { tick: vi.fn(async () => undefined) };
    const coordinator = new AiAgentTickCoordinator(1_000, () => now);

    await expect(coordinator.run(agent, "NIFTY50", "1d", 24_500)).resolves.toBe(true);
    now += 999;
    await expect(coordinator.run(agent, "NIFTY50", "1d", 24_501)).resolves.toBe(false);
    await expect(coordinator.run(agent, "BANKNIFTY", "1d", 50_000)).resolves.toBe(true);
    now += 1;
    await expect(coordinator.run(agent, "NIFTY50", "1d", 24_502)).resolves.toBe(true);

    expect(agent.tick).toHaveBeenCalledTimes(3);
  });

  it("releases a failed tick so the next eligible evaluation can retry", async () => {
    let now = 10_000;
    const agent: AiAgentTicker = {
      tick: vi.fn()
        .mockRejectedValueOnce(new Error("temporary failure"))
        .mockResolvedValueOnce(undefined),
    };
    const coordinator = new AiAgentTickCoordinator(1_000, () => now);

    await expect(coordinator.run(agent, "NIFTY50", "1d", 24_500)).rejects.toThrow("temporary failure");
    now += 1_000;
    await expect(coordinator.run(agent, "NIFTY50", "1d", 24_501)).resolves.toBe(true);

    expect(agent.tick).toHaveBeenCalledTimes(2);
  });
});
