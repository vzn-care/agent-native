import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { startControlGateway } from "./control.ts";

const [
  stateDirectory,
  tokenPath,
  browserOriginsText,
  portText = "45840",
  publicOrigin,
  taskControl,
] = process.argv.slice(2);
if (!stateDirectory || !tokenPath || !browserOriginsText) {
  console.error(
    "Usage: node src/cli.ts <host-state-directory> <owner-token-file> <comma-separated-browser-origins> [port] [public-origin-or-dash] [allow-task-control]",
  );
  process.exitCode = 1;
} else {
  const allowedOrigins = browserOriginsText.split(",");
  if (allowedOrigins.some((origin) => !origin || origin !== origin.trim()))
    throw new Error(
      "Browser origins must be a comma-separated list of exact origins",
    );
  const tokenInfo = await stat(tokenPath);
  if (
    !tokenInfo.isFile() ||
    (tokenInfo.mode & 0o077) !== 0 ||
    tokenInfo.uid !== process.getuid?.()
  )
    throw new Error("Token file must be owned by this user and mode 0600");
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid port");
  if (taskControl && taskControl !== "allow-task-control")
    throw new Error("Unknown task-control option");
  const gateway = await startControlGateway({
    socketPath: resolve(stateDirectory, "host.sock"),
    token: (await readFile(tokenPath, "utf8")).trim(),
    allowedOrigins,
    port,
    publicOrigin: publicOrigin === "-" ? undefined : publicOrigin,
    allowTaskControl: taskControl === "allow-task-control",
  });
  console.log(
    `VZN Code browser gateway listening on ${gateway.url}; no public listener enabled`,
  );
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await gateway.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
