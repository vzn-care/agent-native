import { DatabaseSync } from "node:sqlite";

import { HostError } from "./protocol.ts";

/** A separate database keeps the OS-owned service lease outside journal transactions. */
export class HostLease {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
    } catch (error) {
      this.db.close();
      if (
        error instanceof Error &&
        "errcode" in error &&
        (error.errcode === 5 || error.errcode === 6)
      )
        throw new HostError(
          "HOST_ALREADY_RUNNING",
          "Another host owns this state directory",
        );
      throw new HostError(
        "HOST_LOCK_FAILED",
        "Could not acquire the host state lock",
      );
    }
  }
  close(): void {
    this.db.close();
  }
}
