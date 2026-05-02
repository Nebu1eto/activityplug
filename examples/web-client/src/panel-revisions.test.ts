import { describe, expect, it } from "vitest";

import { PanelRevisionTracker } from "./panel-revisions.js";

describe("panel revision tracker", () => {
  it("skips hydration writes after a panel request starts", () => {
    const tracker = new PanelRevisionTracker<object>();
    const captured = tracker.current("search");

    tracker.beginRequest("search", {}, 1);

    expect(tracker.canHydrate("search", captured)).toBe(false);
  });

  it("suppresses older duplicate panel requests", () => {
    const tracker = new PanelRevisionTracker<object>();
    const client = {};
    const older = tracker.beginRequest("search", client, 1);
    const newer = tracker.beginRequest("search", client, 1);

    expect(tracker.isCurrentRequest(older, client, 1)).toBe(false);
    expect(tracker.isCurrentRequest(newer, client, 1)).toBe(true);
  });

  it("suppresses stale rejected requests after session changes", () => {
    const tracker = new PanelRevisionTracker<object>();
    const previousClient = {};
    const currentClient = {};
    const request = tracker.beginRequest("action", previousClient, 1);

    expect(tracker.isCurrentRequest(request, previousClient, 2)).toBe(false);
    expect(tracker.isCurrentRequest(request, currentClient, 1)).toBe(false);
  });
});
