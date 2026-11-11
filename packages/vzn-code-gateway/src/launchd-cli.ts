import {
  gatewayLaunchAgentStatus,
  installGatewayLaunchAgent,
  uninstallGatewayLaunchAgent,
  type GatewayInstance,
} from "./launchd.ts";
import { HostError } from "../../vzn-code-host/src/protocol.ts";

function instance(value: string | undefined): GatewayInstance {
  if (value === "local" || value === "preview") return value;
  throw new HostError("USAGE", "Instance must be local or preview");
}

function main(): void {
  const [command, instanceText, ...args] = process.argv.slice(2);
  const selected = instance(instanceText);
  if (command === "status" || command === "uninstall") {
    if (args.length)
      throw new HostError("USAGE", `${command} accepts only the instance`);
    if (command === "status")
      console.log(JSON.stringify(gatewayLaunchAgentStatus(selected)));
    else {
      uninstallGatewayLaunchAgent(selected);
      console.log(JSON.stringify({ installed: false, loaded: false }));
    }
    return;
  }
  if (command !== "install" || args.length < 4 || args.length > 6)
    throw new HostError(
      "USAGE",
      "Commands: install <local|preview> <state-dir> <owner-token-file> <comma-separated-browser-origins> <port> [public-origin-or-dash] [allow-task-control], status <local|preview>, uninstall <local|preview>",
    );
  const [
    stateDir,
    tokenPath,
    browserOrigins,
    portText,
    publicOrigin,
    taskControl,
  ] = args;
  if (taskControl && taskControl !== "allow-task-control")
    throw new HostError("USAGE", "Unknown task-control option");
  const port = Number(portText);
  console.log(
    JSON.stringify({
      path: installGatewayLaunchAgent({
        instance: selected,
        stateDir: stateDir!,
        tokenPath: tokenPath!,
        browserOrigins: browserOrigins!,
        port,
        publicOrigin: publicOrigin === "-" ? undefined : publicOrigin,
        allowTaskControl: taskControl === "allow-task-control",
      }),
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
