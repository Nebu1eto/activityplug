import { describe, expect, it } from "vitest";

import { parseServerCliArgs } from "./cli.js";

describe("server CLI parsing", () => {
  it("accepts explicit host and port options", () => {
    expect(parseServerCliArgs(["--host", "0.0.0.0", "--port", "8080"])).toEqual({
      hostname: "0.0.0.0",
      port: 8080,
    });
  });

  it("rejects invalid runtime options before the server starts", () => {
    expect(() => parseServerCliArgs(["--port", "0"])).toThrow(
      expect.objectContaining({
        exitCode: 1,
      }),
    );
    expect(() => parseServerCliArgs(["--host", "", "--port", "4000"])).toThrow(
      expect.objectContaining({
        exitCode: 1,
      }),
    );
  });

  it("lets Optique handle help output without treating it as a validation error", () => {
    expect(() => parseServerCliArgs(["--help"])).toThrow(
      expect.objectContaining({
        exitCode: 0,
      }),
    );
  });
});
