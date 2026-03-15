import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type Dictionary = Record<string, unknown>;

interface PaperclipEnvelope {
  runId: string;
  agentId: string;
  companyId: string;
  agentName?: string | null;
  apiBaseUrl?: string | null;
  authToken?: string | null;
  callbacks?: {
    updateUrl?: string | null;
  } | null;
  context?: Record<string, unknown> | null;
}

interface BridgeCommandConfig {
  command?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string | null;
  metadata?: Record<string, unknown>;
  shell?: boolean;
}

interface BridgeProfile extends BridgeCommandConfig {}

interface BridgeConfigFile {
  profiles?: Record<string, BridgeProfile>;
}

interface InvokeBody extends Dictionary {
  paperclip?: PaperclipEnvelope;
  bridge?: {
    profile?: string;
    command?: string[];
    cwd?: string;
    env?: Record<string, string>;
    stdin?: string | null;
    metadata?: Record<string, unknown>;
    shell?: boolean;
  };
}

interface ActiveRun {
  externalRunId: string;
  runId: string;
  updateUrl: string;
  authToken: string;
  child: ChildProcessWithoutNullStreams;
  flushTimer: NodeJS.Timeout | null;
  pendingLogs: Array<{ stream: "stdout" | "stderr"; chunk: string }>;
  finishing: boolean;
}

const DEFAULT_PORT = Number(process.env.PRO_BRIDGE_PORT ?? "3211");
const DEFAULT_HOST = process.env.PRO_BRIDGE_HOST ?? "127.0.0.1";
const DEFAULT_ORIGIN_HOST = process.env.PRO_BRIDGE_ORIGIN_HOST ?? "pro";
const DEFAULT_EXECUTION_TARGET = process.env.PRO_BRIDGE_EXECUTION_TARGET ?? "pro-bridge";
const DEFAULT_LOG_BATCH_MS = Math.max(10, Number(process.env.PRO_BRIDGE_LOG_BATCH_MS ?? "250"));
const PUBLIC_BASE_URL = process.env.PRO_BRIDGE_PUBLIC_BASE_URL?.trim() || null;
const WEBHOOK_BEARER = process.env.PRO_BRIDGE_WEBHOOK_BEARER?.trim() || null;
const CONFIG_PATH = process.env.PRO_BRIDGE_CONFIG?.trim() || null;

const activeRuns = new Map<string, ActiveRun>();
let configCache: BridgeConfigFile | null = null;
let configLoadedFrom: string | null = null;

function isObject(value: unknown): value is Dictionary {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function readRecordOfStrings(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") out[key] = raw;
  }
  return out;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length > 0 ? JSON.parse(text) : {};
}

function sendJson(res: ServerResponse, statusCode: number, body: JsonValue) {
  const json = JSON.stringify(body, null, 2);
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(json));
  res.end(json);
}

function unauthorized(res: ServerResponse, detail: string) {
  sendJson(res, 401, { error: detail });
}

function notFound(res: ServerResponse) {
  sendJson(res, 404, { error: "Not found" });
}

function badRequest(res: ServerResponse, detail: string) {
  sendJson(res, 400, { error: detail });
}

function ensureWebhookAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (!WEBHOOK_BEARER) return true;
  const auth = req.headers.authorization?.trim();
  if (auth === `Bearer ${WEBHOOK_BEARER}`) return true;
  unauthorized(res, "Invalid or missing bearer token");
  return false;
}

function resolvePathValue(obj: unknown, dottedPath: string): string {
  const parts = dottedPath.split(".");
  let cursor = obj;
  for (const part of parts) {
    if (!isObject(cursor)) return "";
    cursor = cursor[part];
  }
  if (cursor === null || cursor === undefined) return "";
  if (typeof cursor === "string") return cursor;
  if (typeof cursor === "number" || typeof cursor === "boolean") return String(cursor);
  try {
    return JSON.stringify(cursor);
  } catch {
    return "";
  }
}

function renderTemplate(value: string, data: unknown): string {
  return value.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_, key: string) => resolvePathValue(data, key));
}

function renderStringArray(values: string[], data: unknown): string[] {
  return values.map((value) => renderTemplate(value, data));
}

function renderStringRecord(values: Record<string, string>, data: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, renderTemplate(value, data)]));
}

async function loadConfig(): Promise<BridgeConfigFile> {
  if (!CONFIG_PATH) return {};
  if (configCache && configLoadedFrom === CONFIG_PATH) return configCache;
  const raw = await readFile(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isObject(parsed)) throw new Error(`Bridge config at ${CONFIG_PATH} must be a JSON object`);
  const profiles = isObject(parsed.profiles) ? parsed.profiles : {};
  const normalizedProfiles: Record<string, BridgeProfile> = {};
  for (const [name, profile] of Object.entries(profiles)) {
    if (!isObject(profile)) continue;
    normalizedProfiles[name] = {
      command: readStringArray(profile.command),
      cwd: readString(profile.cwd) ?? undefined,
      env: readRecordOfStrings(profile.env),
      stdin: readString(profile.stdin),
      metadata: isObject(profile.metadata) ? profile.metadata : undefined,
      shell: typeof profile.shell === "boolean" ? profile.shell : undefined,
    };
  }
  configCache = { profiles: normalizedProfiles };
  configLoadedFrom = CONFIG_PATH;
  return configCache;
}

async function resolveBridgeConfig(body: InvokeBody): Promise<Required<BridgeCommandConfig>> {
  const bridge = isObject(body.bridge) ? body.bridge : {};
  const config = await loadConfig();
  const profileName = readString(bridge.profile);
  const profile = profileName ? config.profiles?.[profileName] : undefined;
  if (profileName && !profile) {
    throw new Error(`Unknown bridge profile "${profileName}"`);
  }

  const context = body as unknown;
  const mergedCommand = renderStringArray(
    readStringArray(bridge.command).length > 0 ? readStringArray(bridge.command) : profile?.command ?? [],
    context,
  );
  const mergedCwd = renderTemplate(readString(bridge.cwd) ?? profile?.cwd ?? "", context).trim();
  const mergedEnv = renderStringRecord(
    {
      ...(profile?.env ?? {}),
      ...readRecordOfStrings(bridge.env),
    },
    context,
  );
  const mergedStdin = renderTemplate(readString(bridge.stdin) ?? profile?.stdin ?? "", context);
  const metadata = {
    ...(profile?.metadata ?? {}),
    ...(isObject(bridge.metadata) ? bridge.metadata : {}),
  };
  const shell = typeof bridge.shell === "boolean" ? bridge.shell : profile?.shell ?? false;

  if (mergedCommand.length === 0) {
    throw new Error("Bridge invoke requires bridge.command or bridge.profile with a command");
  }
  if (!path.isAbsolute(mergedCwd)) {
    throw new Error("Bridge invoke requires an absolute bridge.cwd or profile cwd");
  }
  await access(mergedCwd, fsConstants.R_OK);

  return {
    command: mergedCommand,
    cwd: mergedCwd,
    env: mergedEnv,
    stdin: mergedStdin.length > 0 ? mergedStdin : null,
    metadata,
    shell,
  };
}

async function postUpdate(run: ActiveRun, payload: Dictionary) {
  const res = await fetch(run.updateUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${run.authToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Paperclip callback failed (${res.status}): ${text}`);
  }
}

async function flushLogs(run: ActiveRun) {
  if (run.pendingLogs.length === 0) return;
  const logs = run.pendingLogs.splice(0, run.pendingLogs.length);
  try {
    await postUpdate(run, { logs });
  } catch (error) {
    console.error(`[pro-bridge] failed to flush logs for ${run.externalRunId}:`, error);
  }
}

function scheduleFlush(run: ActiveRun) {
  if (run.flushTimer) return;
  run.flushTimer = setTimeout(async () => {
    run.flushTimer = null;
    await flushLogs(run);
  }, DEFAULT_LOG_BATCH_MS);
}

function enqueueLog(run: ActiveRun, stream: "stdout" | "stderr", chunk: string) {
  if (!chunk) return;
  run.pendingLogs.push({ stream, chunk });
  scheduleFlush(run);
}

async function finalizeRun(run: ActiveRun, payload: Dictionary) {
  if (run.finishing) return;
  run.finishing = true;
  if (run.flushTimer) {
    clearTimeout(run.flushTimer);
    run.flushTimer = null;
  }
  await flushLogs(run);
  try {
    await postUpdate(run, payload);
  } finally {
    activeRuns.delete(run.externalRunId);
  }
}

async function handleInvoke(body: InvokeBody, req: IncomingMessage, res: ServerResponse) {
  const paperclip = isObject(body.paperclip) ? body.paperclip as PaperclipEnvelope : null;
  if (!paperclip) {
    badRequest(res, "Missing paperclip envelope");
    return;
  }
  const runId = readString(paperclip.runId);
  const updateUrl = readString(paperclip.callbacks?.updateUrl);
  const authToken = readString(paperclip.authToken);
  if (!runId || !updateUrl || !authToken) {
    badRequest(res, "paperclip.runId, paperclip.callbacks.updateUrl, and paperclip.authToken are required");
    return;
  }

  let commandConfig: Required<BridgeCommandConfig>;
  try {
    commandConfig = await resolveBridgeConfig(body);
  } catch (error) {
    badRequest(res, error instanceof Error ? error.message : String(error));
    return;
  }

  const externalRunId = `pro-${randomUUID()}`;
  const protocol = readString(req.headers["x-forwarded-proto"]) ?? "http";
  const requestHost = readString(req.headers.host);
  const publicBaseUrl = PUBLIC_BASE_URL ?? (requestHost ? `${protocol}://${requestHost}` : `http://${DEFAULT_HOST}:${DEFAULT_PORT}`);
  const child = spawn(commandConfig.command[0], commandConfig.command.slice(1), {
    cwd: commandConfig.cwd,
    env: {
      ...process.env,
      ...commandConfig.env,
      PAPERCLIP_RUN_ID: runId,
      PAPERCLIP_AGENT_ID: paperclip.agentId,
      PAPERCLIP_COMPANY_ID: paperclip.companyId,
      PAPERCLIP_AGENT_NAME: paperclip.agentName ?? "",
      PAPERCLIP_UPDATE_URL: updateUrl,
    },
    shell: commandConfig.shell,
    stdio: "pipe",
  });

  const run: ActiveRun = {
    externalRunId,
    runId,
    updateUrl,
    authToken,
    child,
    flushTimer: null,
    pendingLogs: [],
    finishing: false,
  };
  activeRuns.set(externalRunId, run);

  child.stdout.on("data", (chunk) => enqueueLog(run, "stdout", String(chunk)));
  child.stderr.on("data", (chunk) => enqueueLog(run, "stderr", String(chunk)));
  child.on("error", async (error) => {
    console.error(`[pro-bridge] child error for ${externalRunId}:`, error);
    await finalizeRun(run, {
      status: "failed",
      errorMessage: error.message,
      summary: "pro-bridge child process errored",
      externalRunId,
      originHost: DEFAULT_ORIGIN_HOST,
      executionTarget: DEFAULT_EXECUTION_TARGET,
    });
  });
  child.on("close", async (code, signal) => {
    const status = code === 0 ? "succeeded" : signal ? "cancelled" : "failed";
    await finalizeRun(run, {
      status,
      exitCode: code,
      signal,
      summary: `${commandConfig.command.join(" ")} ${status}`,
      externalRunId,
      originHost: DEFAULT_ORIGIN_HOST,
      executionTarget: DEFAULT_EXECUTION_TARGET,
      resultJson: {
        command: commandConfig.command,
        cwd: commandConfig.cwd,
        metadata: commandConfig.metadata,
      },
    });
  });

  if (commandConfig.stdin) {
    child.stdin.write(commandConfig.stdin);
  }
  child.stdin.end();

  await postUpdate(run, {
    status: "running",
    summary: `${commandConfig.command.join(" ")} started`,
    externalRunId,
    originHost: DEFAULT_ORIGIN_HOST,
    executionTarget: DEFAULT_EXECUTION_TARGET,
    resultJson: {
      command: commandConfig.command,
      cwd: commandConfig.cwd,
      metadata: commandConfig.metadata,
      trigger: req.headers["x-paperclip-trigger"] ?? null,
    },
  }).catch((error) => {
    console.error(`[pro-bridge] failed initial callback for ${externalRunId}:`, error);
  });

  sendJson(res, 202, {
    accepted: true,
    externalRunId,
    originHost: DEFAULT_ORIGIN_HOST,
    executionTarget: DEFAULT_EXECUTION_TARGET,
    cancelUrl: `${publicBaseUrl}/paperclip/cancel/${externalRunId}`,
  });
}

async function handleCancel(externalRunId: string, res: ServerResponse) {
  const run = activeRuns.get(externalRunId);
  if (!run) {
    notFound(res);
    return;
  }
  run.child.kill("SIGTERM");
  sendJson(res, 200, { ok: true, externalRunId });
}

function printHelp() {
  console.log(`pro-bridge

Environment:
  PRO_BRIDGE_HOST               Listen host (default: 127.0.0.1)
  PRO_BRIDGE_PORT               Listen port (default: 3211)
  PRO_BRIDGE_CONFIG             Optional JSON config file with profiles
  PRO_BRIDGE_WEBHOOK_BEARER     Optional bearer token required on invoke/cancel
  PRO_BRIDGE_ORIGIN_HOST        originHost returned to Paperclip (default: pro)
  PRO_BRIDGE_EXECUTION_TARGET   executionTarget returned to Paperclip (default: pro-bridge)
  PRO_BRIDGE_PUBLIC_BASE_URL    Public callback base URL for cancel links

Endpoints:
  GET  /health
  POST /paperclip/invoke
  POST /paperclip/cancel/:externalRunId
`);
}

if (process.argv.includes("--help")) {
  printHelp();
  process.exit(0);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        host: DEFAULT_HOST,
        port: DEFAULT_PORT,
        activeRuns: activeRuns.size,
        configPath: CONFIG_PATH,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/paperclip/invoke") {
      if (!ensureWebhookAuth(req, res)) return;
      const body = (await readJsonBody(req)) as InvokeBody;
      await handleInvoke(body, req, res);
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/paperclip/cancel/")) {
      if (!ensureWebhookAuth(req, res)) return;
      const externalRunId = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      if (!externalRunId) {
        badRequest(res, "Missing external run id");
        return;
      }
      await handleCancel(externalRunId, res);
      return;
    }

    notFound(res);
  } catch (error) {
    console.error("[pro-bridge] request failed:", error);
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(DEFAULT_PORT, DEFAULT_HOST, () => {
  console.log(
    `[pro-bridge] listening on http://${DEFAULT_HOST}:${DEFAULT_PORT} ` +
      `(config=${CONFIG_PATH ?? "none"}, auth=${WEBHOOK_BEARER ? "bearer" : "off"})`,
  );
});

server.on("error", (error) => {
  console.error("[pro-bridge] failed to start:", error);
  process.exit(1);
});
