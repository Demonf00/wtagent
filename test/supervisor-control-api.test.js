import test from "node:test";
import assert from "node:assert/strict";
import { startControlApi } from "../src/supervisor/control-api.js";

const TOKEN = "test-supervisor-api-token-at-least-32-bytes";
const TASK_ID = `task_${"a".repeat(8)}-${"b".repeat(4)}-${"c".repeat(4)}-${"d".repeat(4)}-${"e".repeat(12)}`;
const REQUEST_ID = "f".repeat(64);

async function fixture(run) {
  const calls = [];
  const task = { taskId: TASK_ID, status: "queued" };
  const supervisor = {
    initialized: true,
    list: () => [task],
    get: (id) => { calls.push(["get", id]); return task; },
    getEvents: async (id, after) => { calls.push(["events", id, after]); return []; },
    create: async (body) => { calls.push(["create", body]); return task; },
    pause: async (id) => { calls.push(["pause", id]); return task; },
    resume: async (id) => { calls.push(["resume", id]); return task; },
    cancel: async (id) => { calls.push(["cancel", id]); return task; },
    decide: async (id, requestId, decision) => {
      calls.push(["decide", id, requestId, decision]);
      return task;
    },
  };
  const api = await startControlApi({ supervisor, token: TOKEN });
  async function request(route, { method = "GET", body, auth = true, headers = {} } = {}) {
    const response = await fetch(`${api.url}${route}`, {
      method,
      headers: {
        ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  }
  try {
    await run({ request, calls, task });
  } finally {
    await api.close();
  }
}

test("control API requires bearer auth and exposes task list only to authorized clients", async () => {
  await fixture(async ({ request }) => {
    assert.equal((await request("/v1/tasks", { auth: false })).status, 401);
    assert.equal((await request("/v1/tasks", { headers: { authorization: "Bearer wrong" } })).status, 401);
    const response = await request("/v1/tasks");
    assert.equal(response.status, 200);
    assert.equal(response.data.tasks[0].taskId, TASK_ID);
  });
});

test("control API routes task reads, events, and state changes", async () => {
  await fixture(async ({ request, calls }) => {
    assert.equal((await request(`/v1/tasks/${TASK_ID}`)).status, 200);
    assert.equal((await request(`/v1/tasks/${TASK_ID}/events?after=2`)).status, 200);
    assert.equal((await request(`/v1/tasks/${TASK_ID}/pause`, { method: "POST" })).status, 200);
    assert.equal((await request(`/v1/tasks/${TASK_ID}/resume`, { method: "POST" })).status, 200);
    assert.equal((await request(`/v1/tasks/${TASK_ID}/cancel`, { method: "POST" })).status, 200);
    assert.deepEqual(calls, [
      ["get", TASK_ID], ["events", TASK_ID, 2],
      ["pause", TASK_ID], ["resume", TASK_ID], ["cancel", TASK_ID],
    ]);
  });
});

test("control API creates tasks and applies approval decisions", async () => {
  await fixture(async ({ request, calls }) => {
    const body = { workspaceId: "project", instruction: "test request" };
    assert.equal((await request("/v1/tasks", { method: "POST", body })).status, 201);
    assert.equal((await request(`/v1/tasks/${TASK_ID}/approvals/${REQUEST_ID}/decision`, {
      method: "POST", body: { decision: "approve" },
    })).status, 200);
    assert.deepEqual(calls, [
      ["create", body], ["decide", TASK_ID, REQUEST_ID, "approve"],
    ]);
  });
});

test("control API rejects malformed bodies, unexpected fields and invalid event offsets", async () => {
  await fixture(async ({ request, calls }) => {
    assert.equal((await request("/v1/tasks", { method: "POST", body: "{bad" })).status, 400);
    assert.equal((await request("/v1/tasks", { method: "POST", body: { unknown: true } })).status, 400);
    assert.equal((await request("/v1/tasks", {
      method: "POST", body: "{}", headers: { "content-type": "text/plain" },
    })).status, 400);
    assert.equal((await request(`/v1/tasks/${TASK_ID}/events?after=-1`)).status, 400);
    assert.equal((await request("/not-a-route")).status, 404);
    assert.deepEqual(calls, []);
  });
});
