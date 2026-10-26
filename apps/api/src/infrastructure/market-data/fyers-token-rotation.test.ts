import { describe, expect, it } from "vitest";
import { MIN_UPTIME_BEFORE_ROTATION_RESTART_SECONDS, mayRestartForTokenRotation } from "./fyers-token-rotation.js";

describe("mayRestartForTokenRotation", () => {
  it("allows a restart once the process has been up long enough and none is under way", () => {
    expect(mayRestartForTokenRotation({ uptimeSeconds: MIN_UPTIME_BEFORE_ROTATION_RESTART_SECONDS, alreadyRestarting: false })).toBe(true);
    expect(mayRestartForTokenRotation({ uptimeSeconds: 36_000, alreadyRestarting: false })).toBe(true);
  });

  it("refuses within two minutes of start: a fresh process already holds the newest token, so a flapping token cannot cause a restart loop", () => {
    expect(mayRestartForTokenRotation({ uptimeSeconds: 0, alreadyRestarting: false })).toBe(false);
    expect(mayRestartForTokenRotation({ uptimeSeconds: MIN_UPTIME_BEFORE_ROTATION_RESTART_SECONDS - 1, alreadyRestarting: false })).toBe(false);
  });

  it("asks for a restart at most once", () => {
    expect(mayRestartForTokenRotation({ uptimeSeconds: 36_000, alreadyRestarting: true })).toBe(false);
  });
});
