import { homedir } from "node:os";
import { join } from "node:path";

import {
  installLaunchAgent,
  launchAgentStatus,
  uninstallLaunchAgent,
} from "./launchd.ts";
import { HostError } from "./protocol.ts";

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  if (command === "status" || command === "uninstall") {
    if (args.length)
      throw new HostError("USAGE", `${command} accepts no arguments`);
    if (command === "status") console.log(JSON.stringify(launchAgentStatus()));
    else {
      uninstallLaunchAgent();
      console.log(JSON.stringify({ installed: false, loaded: false }));
    }
    return;
  }
  if (command !== "install")
    throw new HostError(
      "USAGE",
      "Commands: install [--state-dir absolute-path] [--runtime-executable absolute-path], status, uninstall",
    );
  let stateDir = join(homedir(), ".vzn-code-host");
  let runtimeExecutable: string | undefined;
  while (args.length) {
    const flag = args.shift();
    const value = args.shift();
    if (!value) throw new HostError("USAGE", `${flag} requires a value`);
    if (flag === "--state-dir") stateDir = value;
    else if (flag === "--runtime-executable") runtimeExecutable = value;
    else throw new HostError("USAGE", `Unknown option ${flag}`);
  }
  console.log(
    JSON.stringify({
      path: installLaunchAgent({ stateDir, runtimeExecutable }),
    }),
  );
}

try {
  main();
} catch (error) {
  console.error(
    JSON.stringify({
      error: error instanceof HostError ? error.code : "LAUNCH_AGENT_FAILED",
      message:
        error instanceof Error ? error.message : "Unknown LaunchAgent failure",
    }),
  );
  process.exitCode = 1;
}
