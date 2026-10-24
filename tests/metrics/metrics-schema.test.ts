import { describe, expect, test } from "vitest";

import { parseMetricsInput } from "../../src/metrics/schema.js";

describe("parseMetricsInput", () => {
  test("rejects a string specialist flag instead of treating it as truthy", () => {
    expect(() =>
      parseMetricsInput(
        JSON.stringify({
          schedule: {
            utcOffsetMinutes: 60,
            weekdays: [1, 2, 3, 4, 5],
            startMinute: 540,
            endMinute: 1020,
            holidays: [],
          },
          baseline: windowWithPullRequest("false"),
          current: windowWithPullRequest(false),
        }),
      ),
    ).toThrow(/specialistRequired/);
  });
});

function windowWithPullRequest(specialistRequired: unknown): unknown {
  return {
    startsAt: "2026-10-01T00:00:00.000Z",
    endsAt: "2026-10-08T00:00:00.000Z",
    pullRequests: [
      {
        repository: "campus-web",
        readyAt: "2026-10-01T08:00:00.000Z",
        specialistRequired,
        specialistSatisfied: false,
      },
    ],
    deployments: [],
    reverts: [],
    incidents: [],
  };
}
