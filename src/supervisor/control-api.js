import http from "node:http";
import { timingSafeEqual } from "node:crypto";

const MAX_BODY = 65_536 + 1_024;
const BODY_KEYS = {
  create: new Set(["workspaceId", "instruction", "provider", "idempotencyKey"]),
  decision: new Set(["decision"]),
};

function httpError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function statusOf(error) {
  switch (error.code) {
    case "BAD_REQUEST": return 400;
    case "NOT_FOUND": return 404;
    case "CONFLICT": return 409;
    case "STORAGE_UNSAFE": return 500;
    default: return 500;
  }
}

function send(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(payload));
}

function isAuthorized(req, token) {
  const incoming = req.headers.authorization;
  if (typeof incoming !== "string" || !incoming.startsWith("Bearer ")) return false;
  const provided = Buffer.from(incoming.slice(7), "utf8");
  const expected = Buffer.from(token, "utf8");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function readBody(req, allowedKeys) {
  if (req.headers["content-type"]?.split(";")[0]?.trim()?.toLowerCase() !== "application/json") {
    throw httpError("BAD_REQUEST", "Content-Type must be application/json.");
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY) throw httpError("BAD_REQUEST", "Request body too large.");
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError("BAD_REQUEST", "Malformed JSON body.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw httpError("BAD_REQUEST", "Unexpected fields in request body.");
  }
  return value;
}

export async function startControlApi({ supervisor, token, port = 0 } = {}) {
  if (!supervisor?.initialized) throw new Error("Supervisor must be initialized first.");
  if (typeof token !== "string" || Buffer.byteLength(token, "utf8") < 32) {
    throw new Error("Supervisor API token must contain at least 32 UTF-8 bytes.");
  }
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error("Invalid API port.");
  }
  const server = http.createServer(async (req, res) => {
    try {
      // Bind to loopback only, plus bearer auth to protect against other local
      // programs and browser-based cross-origin requests.
      if (!isAuthorized(req, token)) {
        send(res, 401, { error: "Unauthorized" });
        return;
      }
      const pathname = new URL(req.url, "http://127.0.0.1").pathname;
      const isGet = req.method === "GET";
      const isPost = req.method === "POST";
      if (isGet && pathname === "/v1/tasks") {
        send(res, 200, { tasks: supervisor.list() });
        return;
      }
      if (isPost && pathname === "/v1/tasks") {
        const body = await readBody(req, BODY_KEYS.create);
        const created = await supervisor.create(body);
        send(res, 201, { task: created });
        return;
      }
      const taskRoute = /^\/v1\/tasks\/(task_[a-f0-9-]{36})(?:\/(events|pause|resume|cancel))?$/.exec(pathname);
      if (taskRoute) {
        const [, id, action] = taskRoute;
        if (isGet && !action) {
          send(res, 200, { task: supervisor.get(id) });
          return;
        }
        if (isGet && action === "events") {
          const since = new URL(req.url, "http://127.0.0.1").searchParams.get("after") ?? "0";
          if (!/^\d{1,15}$/.test(since)) throw httpError("BAD_REQUEST", "Invalid event offset.");
          send(res, 200, { events: await supervisor.getEvents(id, Number(since)) });
          return;
        }
        if (isPost && ["pause", "resume", "cancel"].includes(action)) {
          // No body accepted for state-changing commands.
          const task = await supervisor[action](id);
          send(res, 200, { task });
          return;
        }
      }
      const decisionRoute = /^\/v1\/tasks\/(task_[a-f0-9-]{36})\/approvals\/([a-f0-9]{64})\/decision$/.exec(pathname);
      if (isPost && decisionRoute) {
        const body = await readBody(req, BODY_KEYS.decision);
        const task = await supervisor.decide(decisionRoute[1], decisionRoute[2], body.decision);
        send(res, 200, { task });
        return;
      }
      send(res, 404, { error: "Route not found." });
    } catch (error) {
      send(res, statusOf(error), {
        error: statusOf(error) === 500 ? "Internal supervisor error." : error.message,
        code: error.code ?? "INTERNAL_ERROR",
      });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
  });
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections?.();
    },
  };
}
