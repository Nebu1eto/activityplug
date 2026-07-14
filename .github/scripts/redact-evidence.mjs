import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const redacted = "[REDACTED]";
const credentialKeyPattern =
  /^(?:authorization|password|passwd|secret|clientsecret|accesstoken|refreshtoken|token|apikey|privatekey|sessionid|cookie|setcookie|csrf|csrftoken|challenge|challengeid|databaseurl|redisurl)$/i;
const credentialTextPattern =
  /(["']?(?:authorization|password|passwd|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|token|api[_-]?key|private[_-]?key|session[_-]?id|csrf(?:[_-]?token)?|challenge(?:[_-]?id)?|database[_-]?url|redis[_-]?url)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi;
const bearerPattern = /(Bearer\s+)[A-Za-z0-9._~+/=:-]+/gi;
const cookieHeaderPattern = /((?:set-cookie|cookie)\s*:\s*).+$/gim;
const uriUserInfoPattern = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]*:[^@\s/]+@/gi;
const secretQueryPattern =
  /([?&](?:token|access_token|refresh_token|api_key|secret|password|session_id|csrf|challenge|state|code|ticket)=)[^&#\s]+/gi;

function isCredentialKey(key) {
  return credentialKeyPattern.test(key.replaceAll(/[-_.]/g, ""));
}

export function redactJson(value) {
  if (Array.isArray(value)) return value.map(redactJson);
  if (typeof value === "string") return redactJsonString(value);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      isCredentialKey(key) ? redacted : redactJson(entry),
    ]),
  );
}

function redactJsonString(value) {
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null) {
      return redactPatterns(JSON.stringify(redactJson(parsed)));
    }
  } catch {
    // A JSON string field may contain ordinary log text instead.
  }
  return redactPatterns(value);
}

function redactPatterns(value) {
  return value
    .replace(cookieHeaderPattern, `$1${redacted}`)
    .replace(bearerPattern, `$1${redacted}`)
    .replace(credentialTextPattern, `$1"${redacted}"`)
    .replace(uriUserInfoPattern, `$1${redacted}@`)
    .replace(secretQueryPattern, `$1${redacted}`);
}

function redactParsedJson(value) {
  const serialized = JSON.stringify(redactJson(value));
  const textRedacted = redactPatterns(serialized);
  try {
    JSON.parse(textRedacted);
    return textRedacted;
  } catch {
    return serialized;
  }
}

export function redactText(value) {
  try {
    return redactParsedJson(JSON.parse(value));
  } catch {
    return redactPatterns(value);
  }
}

export function containsCredential(value) {
  try {
    const parsed = JSON.parse(value);
    return redactParsedJson(parsed) !== JSON.stringify(parsed);
  } catch {
    return redactPatterns(value) !== value;
  }
}

async function stream(stageResultsPath) {
  const stageResults =
    stageResultsPath === undefined
      ? undefined
      : createWriteStream(stageResultsPath, { encoding: "utf8", flags: "a" });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (stageResults === undefined) {
      process.stdout.write(`${redactText(line)}\n`);
      continue;
    }
    try {
      const sanitized = redactParsedJson(JSON.parse(line));
      stageResults.write(`${sanitized}\n`);
      process.stdout.write(`${sanitized}\n`);
    } catch {
      process.stdout.write(`${redactText(line)}\n`);
    }
  }
  if (stageResults !== undefined) {
    stageResults.end();
    await finished(stageResults);
  }
}

async function check(paths) {
  for (const path of paths) {
    const contents = await readFile(path, "utf8");
    for (const line of contents.split("\n")) {
      if (containsCredential(line)) {
        throw new Error(`${path} still contains credential-shaped evidence`);
      }
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--check") {
    await check(process.argv.slice(3));
  } else if (process.argv[2] === "--stage-results") {
    await stream(process.argv[3]);
  } else {
    await stream();
  }
}
