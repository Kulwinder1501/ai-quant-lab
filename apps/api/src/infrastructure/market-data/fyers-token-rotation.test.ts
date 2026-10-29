import { describe, expect, it } from "vitest";
import {
  MIN_UPTIME_BEFORE_DEAD_FEED_RESTART_SECONDS,
  MIN_UPTIME_BEFORE_ROTATION_RESTART_SECONDS,
  mayRestartForDeadFeed,
  mayRestartForTokenRotation,
} from "./fyers-token-rotation.js";

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

describe("mayRestartForDeadFeed", () => {
  it("allows a restart once the process has been up ten minutes and none is under way", () => {
    expect(mayRestartForDeadFeed({ uptimeSeconds: MIN_UPTIME_BEFORE_DEAD_FEED_RESTART_SECONDS, alreadyRestarting: false })).toBe(true);
    expect(mayRestartForDeadFeed({ uptimeSeconds: 36_000, alreadyRestarting: false })).toBe(true);
  });

  it("refuses soon after a start, where a feed that is still dead is probably the vendor being down and not what a restart cures", () => {
    expect(mayRestartForDeadFeed({ uptimeSeconds: 0, alreadyRestarting: false })).toBe(false);
    expect(mayRestartForDeadFeed({ uptimeSeconds: MIN_UPTIME_BEFORE_ROTATION_RESTART_SECONDS, alreadyRestarting: false })).toBe(false);
    expect(mayRestartForDeadFeed({ uptimeSeconds: MIN_UPTIME_BEFORE_DEAD_FEED_RESTART_SECONDS - 1, alreadyRestarting: false })).toBe(false);
  });

  it("asks for a restart at most once", () => {
    expect(mayRestartForDeadFeed({ uptimeSeconds: 36_000, alreadyRestarting: true })).toBe(false);
  });
});
