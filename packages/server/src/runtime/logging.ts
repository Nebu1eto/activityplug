import {
  ansiColorFormatter,
  configure,
  getConfig,
  getConsoleSink,
  type LogLevel,
  type Sink,
} from "@logtape/logtape";

export interface ConfigureServerLoggingOptions {
  readonly level?: LogLevel;
  readonly sink?: Sink;
  readonly force?: boolean;
}

export async function configureServerLogging(
  options: ConfigureServerLoggingOptions = {},
): Promise<void> {
  if (getConfig() !== null && options.force !== true) return;
  await configure({
    reset: true,
    sinks: {
      console: options.sink ?? getConsoleSink({ formatter: ansiColorFormatter }),
    },
    loggers: [
      {
        category: "activityplug",
        lowestLevel: options.level ?? "info",
        sinks: ["console"],
      },
      {
        category: ["logtape", "meta"],
        lowestLevel: "warning",
        sinks: ["console"],
      },
    ],
  });
}
