import { writeSync } from "node:fs";

export const FEDIVERSE_TARGETS = ["mastodon", "misskey", "pleroma", "hollo", "hackerspub"] as const;

export type FediverseTarget = (typeof FEDIVERSE_TARGETS)[number];
export type FediverseProfile = FediverseTarget | "mastodon-minimum";

export interface E2EStageResult {
  readonly target: FediverseProfile;
  readonly stage: "checkout" | "build" | "provision" | "server-test" | "adapter-test";
  readonly status: "passed" | "failed";
  readonly external: boolean;
  readonly message: string;
}

export type StageResultReporter = (result: E2EStageResult) => void;

export const reportStageResult: StageResultReporter = (result) => {
  const configured = process.env["ACTIVITYPLUG_E2E_RESULT_FD"];
  const descriptor = configured === undefined ? 1 : Number(configured);
  if (!Number.isInteger(descriptor) || descriptor < 0) {
    throw new TypeError("ACTIVITYPLUG_E2E_RESULT_FD must be a non-negative integer.");
  }
  writeSync(descriptor, `${JSON.stringify(result)}\n`);
};
