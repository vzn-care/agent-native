import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type { Socket } from "node:net";

import { HostError, MAX_FRAME_BYTES } from "./protocol.ts";
import type { Request, Response } from "./protocol.ts";

type RequestBody = Request extends infer R
  ? R extends Request
    ? Omit<R, "requestId" | "protocolVersion">
    : never
  : never;
export class HostClient {
  private socket: Socket;
  private buffer = "";
  private pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  constructor(socketPath: string) {
    this.socket = createConnection(socketPath);
    this.socket.setEncoding("utf8");
    this.socket.setTimeout(15_000, () =>
      this.socket.destroy(new HostError("TIMEOUT", "Host request timed out")),
    );
    this.socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) {
        this.socket.destroy(
          new HostError("INVALID_RESPONSE", "Host response is too large"),
        );
        return;
      }
      let end: number;
      while ((end = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        try {
          const response = JSON.parse(line) as Response;
          if (
            response.protocolVersion !== 1 ||
            typeof response.requestId !== "string" ||
            typeof response.ok !== "boolean"
          )
            throw new HostError(
              "INVALID_RESPONSE",
              "Host returned an invalid envelope",
            );
          const pending = this.pending.get(response.requestId);
          if (!pending)
            throw new HostError(
              "INVALID_RESPONSE",
              "Host returned an unknown request ID",
            );
          this.pending.delete(response.requestId);
          if (response.ok) pending.resolve(response.result);
          else
            pending.reject(
              new HostError(response.error.code, response.error.message),
            );
        } catch (error) {
          this.socket.destroy(
            error instanceof Error ? error : new Error("Invalid response"),
          );
          return;
        }
      }
    });
    this.socket.on("error", (error) => this.fail(error));
    this.socket.on("close", () =>
      this.fail(new HostError("DISCONNECTED", "Host connection closed")),
    );
  }
  private fail(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
  request(body: RequestBody): Promise<unknown> {
    const requestId = randomUUID();
    const frame =
      JSON.stringify({ protocolVersion: 1, requestId, ...body }) + "\n";
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES)
      return Promise.reject(
        new HostError("INVALID_REQUEST", "Request exceeds frame limit"),
      );
    if (this.socket.destroyed)
      return Promise.reject(
        new HostError("DISCONNECTED", "Host connection is closed"),
      );
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.socket.write(frame);
    });
  }
  close(): void {
    this.socket.destroy();
  }
}
