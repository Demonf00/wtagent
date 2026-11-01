import path from "node:path";
import { AgentSession } from "../session/agent-session.js";
import {
  inspectSessionContext,
  prepareContextRotation,
} from "./context-manager.js";

const SCHEMA = 1;
const VALID = new Set(["PENDING", "CREATING", "ROTATED"]);
const ID = /^[a-zA-Z0-9_-]+$/;

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function validatedRequest(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schema !== SCHEMA || !VALID.has(value.status)
    || (value.nextSessionId !== null
      && (typeof value.nextSessionId !== "string"
        || !ID.test(value.nextSessionId)))
    || (value.status === "ROTATED") !== Boolean(value.nextSessionId)) {
    throw failure("CONTEXT_ROTATION_STATE_UNSAFE",
      "Invalid durable context rotation checkpoint.");
  }
  return value;
}

async function fresh(session, sessionsDir) {
  const directory = path.dirname(session.directory);
  if (path.resolve(sessionsDir) !== directory) {
    throw failure("CONTEXT_ROTATION_STATE_UNSAFE",
      "Session must rotate within its own sessions directory.");
  }
  return AgentSession.load({
    sessionsDir, sessionId: session.sessionId,
  });
}

/**
 * An automatic rotation is not permission to resend any message or tool.
 *
 * The durable CREATING marker is written BEFORE allocating a new Session.
 * A crash during creation cannot safely be retried: the caller must inspect
 * the persisted sessions rather than create a possible duplicate.
 */
export async function advanceAutomaticContextRotation({
  session, sessionsDir, options = {},
} = {}) {
  if (!session || !sessionsDir) {
    throw failure("CONTEXT_ROTATION_STATE_UNSAFE",
      "Session and sessionsDir are required.");
  }
  let current = await fresh(session, sessionsDir);
  const request = validatedRequest(current.state.automaticContextRotation);
  if (request?.status === "CREATING") {
    return { status: "UNCERTAIN", reason: "SESSION_CREATION_OUTCOME_UNKNOWN" };
  }
  if (request?.status === "ROTATED") {
    const next = await AgentSession.load({
      sessionsDir, sessionId: request.nextSessionId,
    }).catch(() => {
      throw failure("CONTEXT_ROTATION_STATE_UNSAFE",
        "Recorded replacement Session is unavailable.");
    });
    if (next.state.previousContextSessionId !== current.sessionId) {
      throw failure("CONTEXT_ROTATION_STATE_UNSAFE",
        "Replacement Session identity does not match rotation checkpoint.");
    }
    return { status: "ROTATED", next, reused: true };
  }

  let pressure = await inspectSessionContext(current, options);
  if (!request && !pressure.warning) {
    return { status: "NOT_NEEDED", pressure };
  }
  if (!request) {
    await current.update({
      automaticContextRotation: {
        schema: SCHEMA, status: "PENDING", nextSessionId: null,
      },
    });
    current = await fresh(session, sessionsDir);
    validatedRequest(current.state.automaticContextRotation);
    pressure = await inspectSessionContext(current, options);
  }
  if (!pressure.rotationAllowed) {
    // Leave the exact old Session, browser identity, pending result, and
    // side-effect ledger unchanged. The next invocation may safely retry.
    return { status: "DEFERRED", blockers: pressure.blockers, pressure };
  }

  // Fail closed across a crash between Session creation and recording its ID.
  await current.update({
    automaticContextRotation: {
      schema: SCHEMA, status: "CREATING", nextSessionId: null,
    },
  });
  let result;
  try {
    result = await prepareContextRotation({ session: current, sessionsDir, options });
  } catch (error) {
    // If we know a rotation did not occur because the safety check rejected
    // it, restoring PENDING is safe. All other failures are ambiguous.
    if (error?.code === "CONTEXT_ROTATION_UNSAFE") {
      const retry = await fresh(session, sessionsDir);
      await retry.update({
        automaticContextRotation: {
          schema: SCHEMA, status: "PENDING", nextSessionId: null,
        },
      });
      return { status: "DEFERRED", blockers: (await inspectSessionContext(
        retry, options)).blockers };
    }
    throw failure("CONTEXT_ROTATION_CREATION_UNKNOWN",
      "Session creation outcome is uncertain; automatic retry is disabled.");
  }

  const committed = await fresh(session, sessionsDir);
  await committed.update({
    automaticContextRotation: {
      schema: SCHEMA, status: "ROTATED",
      nextSessionId: result.next.sessionId,
    },
  });
  return { status: "ROTATED", next: result.next, reused: false };
}
