import { reset, type LogRecord } from "@logtape/logtape";
import { afterEach, describe, expect, it } from "vitest";

import { configureServerLogging } from "./logging.js";
import { startActivityPlugServer } from "./server.js";

describe("server runtime logging", () => {
  afterEach(async () => {
    await reset();
  });

  it("logs startup metadata without secret-bearing runtime options", async () => {
    const records: LogRecord[] = [];
    await configureServerLogging({
      force: true,
      sink: (record) => records.push(record),
    });

    const started = startActivityPlugServer({
      hostname: "127.0.0.1",
      port: 0,
    });
    await new Promise<void>((resolve, reject) => {
      started.server.once("listening", resolve);
      started.server.once("error", reject);
    });
    await new Promise<void>((resolve, reject) => {
      started.server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });

    expect(records).toContainEqual(
      expect.objectContaining({
        category: ["activityplug", "server"],
        level: "info",
        properties: expect.objectContaining({
          hostname: expect.any(String),
          port: expect.any(Number),
        }),
      }),
    );
    expect(JSON.stringify(records)).not.toContain("token");
    expect(JSON.stringify(records)).not.toContain("secret");
  });
});
