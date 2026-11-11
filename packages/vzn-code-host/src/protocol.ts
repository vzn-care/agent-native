export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 64 * 1024;
export const CAPABILITIES = [
  "project-catalog",
  "session-event-replay",
] as const;
export type Capability = (typeof CAPABILITIES)[number];
export class HostError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HostError";
    this.code = code;
  }
}

type Envelope = { protocolVersion: 1; requestId: string };
export type Request = Envelope &
  (
    | { kind: "hello"; capabilities: string[] }
    | { kind: "health" }
    | { kind: "list-projects" }
    | {
        kind: "register-project";
        operationId: string;
        projectId: string;
        root: string;
        repository: string;
      }
    | { kind: "enroll-repository"; projectId: string }
    | { kind: "repository-status"; projectId: string }
    | {
        kind: "ensure-deploy-key";
        projectId: string;
        deviceId: string;
        publicKey: string;
        readOnly: boolean;
      }
    | { kind: "revoke-deploy-key"; projectId: string; deviceId: string }
    | {
        kind: "create-workspace";
        operationId: string;
        workspaceId: string;
        projectId: string;
      }
    | { kind: "list-workspaces"; projectId: string }
    | {
        kind: "start-run";
        operationId: string;
        runId: string;
        workspaceId: string;
        sessionId: string;
        expectedEpoch: number;
        prompt: string;
        permissionMode?: "read-only" | "full-auto";
      }
    | {
        kind: "cancel-run";
        operationId: string;
        runId: string;
        expectedEpoch: number;
      }
    | { kind: "run-status"; runId: string }
    | { kind: "run-transcript"; runId: string }
    | {
        kind: "session-events";
        sessionId: string;
        after: number;
        limit: number;
      }
  );
export type Response =
  | { protocolVersion: 1; requestId: string; ok: true; result: unknown }
  | {
      protocolVersion: 1;
      requestId: string;
      ok: false;
      error: { code: string; message: string };
    };

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new HostError("INVALID_REQUEST", "Expected an object");
  return value as Record<string, unknown>;
}
export function identifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)
  )
    throw new HostError("INVALID_REQUEST", `Invalid ${field}`);
  return value;
}
function string(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    value.includes("\0")
  )
    throw new HostError("INVALID_REQUEST", `Invalid ${field}`);
  return value;
}
function integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new HostError("INVALID_REQUEST", `Invalid ${field}`);
  return value;
}
export function parseRequest(input: unknown): Request {
  const r = record(input);
  if (r.protocolVersion !== 1)
    throw new HostError(
      "UNSUPPORTED_VERSION",
      "Only protocol version 1 is supported",
    );
  const common: Envelope = {
    protocolVersion: 1,
    requestId: identifier(r.requestId, "requestId"),
  };
  let result: Request;
  switch (r.kind) {
    case "hello":
      if (
        !Array.isArray(r.capabilities) ||
        r.capabilities.length > 32 ||
        !r.capabilities.every((v) => typeof v === "string" && v.length <= 128)
      )
        throw new HostError("INVALID_REQUEST", "Invalid capabilities");
      result = {
        ...common,
        kind: r.kind,
        capabilities: r.capabilities as string[],
      };
      break;
    case "health":
    case "list-projects":
      result = { ...common, kind: r.kind };
      break;
    case "register-project":
      result = {
        ...common,
        kind: r.kind,
        operationId: identifier(r.operationId, "operationId"),
        projectId: identifier(r.projectId, "projectId"),
        root: string(r.root, "root"),
        repository: string(r.repository, "repository"),
      };
      break;
    case "enroll-repository":
    case "repository-status":
      result = {
        ...common,
        kind: r.kind,
        projectId: identifier(r.projectId, "projectId"),
      };
      break;
    case "ensure-deploy-key":
      if (typeof r.readOnly !== "boolean")
        throw new HostError("INVALID_REQUEST", "Invalid readOnly");
      result = {
        ...common,
        kind: r.kind,
        projectId: identifier(r.projectId, "projectId"),
        deviceId: identifier(r.deviceId, "deviceId"),
        publicKey: string(r.publicKey, "publicKey"),
        readOnly: r.readOnly,
      };
      break;
    case "revoke-deploy-key":
      result = {
        ...common,
        kind: r.kind,
        projectId: identifier(r.projectId, "projectId"),
        deviceId: identifier(r.deviceId, "deviceId"),
      };
      break;
    case "create-workspace":
      result = {
        ...common,
        kind: r.kind,
        operationId: identifier(r.operationId, "operationId"),
        workspaceId: identifier(r.workspaceId, "workspaceId"),
        projectId: identifier(r.projectId, "projectId"),
      };
      break;
    case "list-workspaces":
      result = {
        ...common,
        kind: r.kind,
        projectId: identifier(r.projectId, "projectId"),
      };
      break;
    case "start-run":
      if (
        r.permissionMode !== undefined &&
        r.permissionMode !== "read-only" &&
        r.permissionMode !== "full-auto"
      )
        throw new HostError("INVALID_REQUEST", "Invalid permission mode");
      result = {
        ...common,
        kind: r.kind,
        operationId: identifier(r.operationId, "operationId"),
        runId: identifier(r.runId, "runId"),
        workspaceId: identifier(r.workspaceId, "workspaceId"),
        sessionId: identifier(r.sessionId, "sessionId"),
        expectedEpoch: integer(r.expectedEpoch, "expectedEpoch"),
        prompt: string(r.prompt, "prompt"),
        permissionMode: r.permissionMode ?? "read-only",
      };
      break;
    case "cancel-run":
      result = {
        ...common,
        kind: r.kind,
        operationId: identifier(r.operationId, "operationId"),
        runId: identifier(r.runId, "runId"),
        expectedEpoch: integer(r.expectedEpoch, "expectedEpoch"),
      };
      break;
    case "run-status":
    case "run-transcript":
      result = { ...common, kind: r.kind, runId: identifier(r.runId, "runId") };
      break;
    case "session-events": {
      const limit = integer(r.limit, "limit");
      if (limit < 1 || limit > 500)
        throw new HostError(
          "INVALID_REQUEST",
          "Limit must be between 1 and 500",
        );
      result = {
        ...common,
        kind: r.kind,
        sessionId: identifier(r.sessionId, "sessionId"),
        after: integer(r.after, "after"),
        limit,
      };
      break;
    }
    default:
      throw new HostError(
        "UNSUPPORTED_OPERATION",
        "Operation is not implemented",
      );
  }
  if (Object.keys(r).some((key) => !(key in result)))
    throw new HostError("INVALID_REQUEST", "Unknown request field");
  return result;
}
