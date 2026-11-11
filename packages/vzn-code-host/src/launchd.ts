import { execFileSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
  constants,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HostError } from "./protocol.ts";
import { privateDirectory } from "./service.ts";

export const LAUNCH_AGENT_LABEL = "care.vzn.code.host";
const marker = "VZN Code host launch agent";

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

export function launchAgentPlist(options: {
  label: string;
  nodeExecutable: string;
  hostCli: string;
  stateDir: string;
  runtimeExecutable?: string;
}): string {
  const args = [
    options.nodeExecutable,
    options.hostCli,
    "serve",
    "--state-dir",
    options.stateDir,
    ...(options.runtimeExecutable
      ? ["--runtime-executable", options.runtimeExecutable]
      : []),
  ];
  const nodeDir = dirname(options.nodeExecutable);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${marker} -->
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(options.label)}</string>
  <key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
  <key>KeepAlive</key><true/>
  <key>Umask</key><string>077</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${xml(`${nodeDir}:/usr/bin:/bin:/usr/sbin:/sbin`)}</string>
    <key>DO_NOT_TRACK</key><string>1</string>
    <key>AGENT_NATIVE_TELEMETRY_DISABLED</key><string>1</string>
  </dict>
  <key>StandardOutPath</key><string>${xml(join(options.stateDir, "host.stdout.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(options.stateDir, "host.stderr.log"))}</string>
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

function agentPath(): string {
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
  return join(directory, `${LAUNCH_AGENT_LABEL}.plist`);
}

function serviceTarget(): string {
  return `gui/${process.getuid?.()}/${LAUNCH_AGENT_LABEL}`;
}

function launchctl(...args: string[]): void {
  execFileSync("/bin/launchctl", args, { stdio: "pipe" });
}

function loaded(): boolean {
  try {
    launchctl("print", serviceTarget());
    return true;
  } catch (error) {
    if (error instanceof Error && "status" in error && error.status === 113)
      return false;
    throw error;
  }
}

export function installLaunchAgent(options: {
  stateDir: string;
  runtimeExecutable?: string;
}): string {
  if (process.platform !== "darwin")
    throw new HostError(
      "UNSUPPORTED_PLATFORM",
      "LaunchAgent installation requires macOS",
    );
  const stateDir = privateDirectory(options.stateDir);
  const hostCli = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const plist = launchAgentPlist({
    label: LAUNCH_AGENT_LABEL,
    nodeExecutable: executable(process.execPath),
    hostCli: realpathSync(hostCli),
    stateDir,
    runtimeExecutable: options.runtimeExecutable
      ? executable(options.runtimeExecutable)
      : undefined,
  });
  const path = agentPath();
  if (existsSync(path))
    throw new HostError(
      "ALREADY_INSTALLED",
      "LaunchAgent file already exists; uninstall before replacing it",
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
    launchctl("enable", serviceTarget());
    launchctl("bootstrap", `gui/${process.getuid?.()}`, path);
  } catch (error) {
    if (loaded()) launchctl("bootout", serviceTarget());
    unlinkSync(path);
    throw error;
  }
  return path;
}

export function launchAgentStatus(): {
  installed: boolean;
  loaded: boolean;
  path: string;
} {
  if (process.platform !== "darwin")
    throw new HostError(
      "UNSUPPORTED_PLATFORM",
      "LaunchAgent status requires macOS",
    );
  const path = agentPath();
  return { installed: existsSync(path), loaded: loaded(), path };
}

export function uninstallLaunchAgent(): void {
  if (process.platform !== "darwin")
    throw new HostError(
      "UNSUPPORTED_PLATFORM",
      "LaunchAgent removal requires macOS",
    );
  const path = agentPath();
  if (!existsSync(path))
    throw new HostError(
      "NOT_INSTALLED",
      "VZN Code LaunchAgent file does not exist",
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
    !contents.includes(`<string>${LAUNCH_AGENT_LABEL}</string>`)
  )
    throw new HostError(
      "UNRECOGNIZED_AGENT",
      "LaunchAgent file was not generated by VZN Code",
    );
  if (loaded()) launchctl("bootout", serviceTarget());
  unlinkSync(path);
}
