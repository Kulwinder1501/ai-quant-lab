import { test, expect } from "vitest";
import { allocateMultiTargetLots } from "./multi-target-bracket.js";

test("allocateMultiTargetLots allocates correctly according to exact tier rules", () => {
  // < 3 lots
  expect(allocateMultiTargetLots(1)).toEqual({ t1: 1, t2: 0, runner: 0 });
  expect(allocateMultiTargetLots(2)).toEqual({ t1: 1, t2: 0, runner: 1 });

  // 3 lots
  // t1 = max(1, floor(1.5)) = 1
  // t2 = max(1, floor(0.9)) = 1
  // runner = 3 - 1 - 1 = 1
  expect(allocateMultiTargetLots(3)).toEqual({ t1: 1, t2: 1, runner: 1 });

  // 4 lots
  // t1 = max(1, floor(2.0)) = 2
  // t2 = max(1, floor(1.2)) = 1
  // runner = 4 - 2 - 1 = 1
  expect(allocateMultiTargetLots(4)).toEqual({ t1: 2, t2: 1, runner: 1 });

  // 5 lots
  // t1 = max(1, floor(2.5)) = 2
  // t2 = max(1, floor(1.5)) = 1
  // runner = 5 - 2 - 1 = 2
  expect(allocateMultiTargetLots(5)).toEqual({ t1: 2, t2: 1, runner: 2 });

  // 6 lots
  // t1 = max(1, floor(3.0)) = 3
  // t2 = max(1, floor(1.8)) = 1
  // runner = 6 - 3 - 1 = 2
  expect(allocateMultiTargetLots(6)).toEqual({ t1: 3, t2: 1, runner: 2 });

  // 7 lots
  // t1 = max(1, floor(3.5)) = 3
  // t2 = max(1, floor(2.1)) = 2
  // runner = 7 - 3 - 2 = 2
  expect(allocateMultiTargetLots(7)).toEqual({ t1: 3, t2: 2, runner: 2 });

  // 10 lots
  // t1 = max(1, floor(5.0)) = 5
  // t2 = max(1, floor(3.0)) = 3
  // runner = 10 - 5 - 3 = 2
  expect(allocateMultiTargetLots(10)).toEqual({ t1: 5, t2: 3, runner: 2 });

  // 20 lots
  // t1 = max(1, floor(10.0)) = 10
  // t2 = max(1, floor(6.0)) = 6
  // runner = 20 - 10 - 6 = 4
  expect(allocateMultiTargetLots(20)).toEqual({ t1: 10, t2: 6, runner: 4 });
});
