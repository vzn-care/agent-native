import { execFileSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HostError } from "../../vzn-code-host/src/protocol.ts";
import { privateDirectory } from "../../vzn-code-host/src/service.ts";

export type GatewayInstance = "local" | "preview";
const label = (instance: GatewayInstance) =>
  `care.vzn.code.gateway.${instance}`;
const marker = "VZN Code browser gateway launch agent";

const xml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[character]!,
  );

export function gatewayLaunchAgentPlist(options: {
  instance: GatewayInstance;
  nodeExecutable: string;
  gatewayCli: string;
  stateDir: string;
  tokenPath: string;
  browserOrigins: string;
  port: number;
  publicOrigin?: string;
  allowTaskControl: boolean;
}): string {
  const args = [
    options.nodeExecutable,
    options.gatewayCli,
    options.stateDir,
    options.tokenPath,
    options.browserOrigins,
    String(options.port),
    options.publicOrigin ?? "-",
    ...(options.allowTaskControl ? ["allow-task-control"] : []),
  ];
  const nodeDir = dirname(options.nodeExecutable);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${marker} -->
<plist version="1.0"><dict>
  <key>Label</key><string>${label(options.instance)}</string>
  <key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>Umask</key><string>077</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${xml(`${nodeDir}:/usr/bin:/bin:/usr/sbin:/sbin`)}</string>
    <key>DO_NOT_TRACK</key><string>1</string>
    <key>AGENT_NATIVE_TELEMETRY_DISABLED</key><string>1</string>
  </dict>
  <key>StandardOutPath</key><string>${xml(join(options.stateDir, `gateway-${options.instance}.stdout.log`))}</string>
  <key>StandardErrorPath</key><string>${xml(join(options.stateDir, `gateway-${options.instance}.stderr.log`))}</string>
</dict></plist>\n`;
}

function executable(path: string): string {
  if (!isAbsolute(path))
    throw new HostError(
      "INVALID_EXECUTABLE",
      "Executable path must be absolute",
    );
  const canonical = realpathSync(path);
  if (!lstatSync(canonical).isFile())
    throw new HostError("INVALID_EXECUTABLE", "Executable path is not a file");
  accessSync(canonical, constants.X_OK);
  return canonical;
}

function privateToken(path: string): string {
  if (!isAbsolute(path))
    throw new HostError("INVALID_TOKEN_FILE", "Token path must be absolute");
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new HostError(
      "INVALID_TOKEN_FILE",
      "Token file must be owned by this user and mode 0600",
    );
  return realpathSync(path);
}

function validateOrigins(browserOrigins: string, publicOrigin?: string): void {
  const origins = browserOrigins.split(",");
  if (
    !origins.length ||
    origins.some((origin) => !origin || origin !== origin.trim())
  )
    throw new HostError(
      "INVALID_ORIGIN",
      "Browser origins must be exact origins",
    );
  for (const origin of origins) {
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      )
    )
      throw new HostError(
        "INVALID_ORIGIN",
        "Browser origins require HTTPS except on loopback",
      );
  }
  if (publicOrigin) {
    const url = new URL(publicOrigin);
    if (url.origin !== publicOrigin || url.protocol !== "https:")
      throw new HostError(
        "INVALID_ORIGIN",
        "Public gateway origin must be HTTPS",
      );
  }
}

function agentPath(instance: GatewayInstance): string {
  const directory = join(homedir(), "Library", "LaunchAgents");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.()
  )
    throw new HostError(
      "UNSAFE_DIRECTORY",
      "LaunchAgents directory is not owned by this user",
    );
  return join(directory, `${label(instance)}.plist`);
}

function serviceTarget(instance: GatewayInstance): string {
  return `gui/${process.getuid?.()}/${label(instance)}`;
}

function launchctl(...args: string[]): void {
  execFileSync("/bin/launchctl", args, { stdio: "pipe" });
}

function loaded(instance: GatewayInstance): boolean {
  try {
    launchctl("print", serviceTarget(instance));
    return true;
  } catch (error) {
    if (error instanceof Error && "status" in error && error.status === 113)
      return false;
    throw error;
  }
}

export function installGatewayLaunchAgent(options: {
  instance: GatewayInstance;
  stateDir: string;
  tokenPath: string;
  browserOrigins: string;
  port: number;
  publicOrigin?: string;
  allowTaskControl: boolean;
}): string {
  if (process.platform !== "darwin")
    throw new HostError(
      "UNSUPPORTED_PLATFORM",
      "LaunchAgent installation requires macOS",
    );
  if (
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65535
  )
    throw new HostError("INVALID_PORT", "Port must be between 1 and 65535");
  validateOrigins(options.browserOrigins, options.publicOrigin);
  const stateDir = privateDirectory(options.stateDir);
  const tokenPath = privateToken(options.tokenPath);
  const gatewayCli = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const plist = gatewayLaunchAgentPlist({
    ...options,
    nodeExecutable: executable(process.execPath),
    gatewayCli: realpathSync(gatewayCli),
    stateDir,
    tokenPath,
  });
  const path = agentPath(options.instance);
  if (existsSync(path))
    throw new HostError(
      "ALREADY_INSTALLED",
      "Gateway LaunchAgent is already installed",
    );
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, plist);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    execFileSync("/usr/bin/plutil", ["-lint", path], { stdio: "pipe" });
    launchctl("enable", serviceTarget(options.instance));
    launchctl("bootstrap", `gui/${process.getuid?.()}`, path);
  } catch (error) {
    if (loaded(options.instance))
      launchctl("bootout", serviceTarget(options.instance));
    unlinkSync(path);
    throw error;
  }
  return path;
}

export function gatewayLaunchAgentStatus(instance: GatewayInstance): {
  installed: boolean;
  loaded: boolean;
  path: string;
} {
  if (process.platform !== "darwin")
    throw new HostError(
      "UNSUPPORTED_PLATFORM",
      "LaunchAgent status requires macOS",
    );
  const path = agentPath(instance);
  return { installed: existsSync(path), loaded: loaded(instance), path };
}

export function uninstallGatewayLaunchAgent(instance: GatewayInstance): void {
  if (process.platform !== "darwin")
    throw new HostError(
      "UNSUPPORTED_PLATFORM",
      "LaunchAgent removal requires macOS",
    );
  const path = agentPath(instance);
  if (!existsSync(path))
    throw new HostError(
      "NOT_INSTALLED",
      "Gateway LaunchAgent is not installed",
    );
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.()
  )
    throw new HostError(
      "UNSAFE_FILE",
      "LaunchAgent file is not owned by this user",
    );
  const contents = readFileSync(path, "utf8");
  if (
    !contents.includes(`<!-- ${marker} -->`) ||
    !contents.includes(`<string>${label(instance)}</string>`)
  )
    throw new HostError(
      "UNRECOGNIZED_AGENT",
      "LaunchAgent file was not generated by VZN Code",
    );
  if (loaded(instance)) launchctl("bootout", serviceTarget(instance));
  unlinkSync(path);
}
