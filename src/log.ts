/**
 * Debug-gated logger with always-on errors.
 *
 * OpenCode does NOT write plugin stderr into
 * `~/.local/share/opencode/log/opencode.log`, and the TUI does not capture it:
 * a stray stderr line is painted straight over the interface. We therefore:
 * 1. Write warn / error to `~/.local/share/opencode-claude/debug.log` always
 * 2. Echo to stderr (for `--print-logs`) only when debugging
 *
 * Failures the user must see reach OpenCode as HTTP errors, not as log lines.
 *
 * Levels:
 * - info: only when OPENCODE_CLAUDE_DEBUG is on
 * - warn / error: always (errors must never be silent)
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

function debugEnabled(): boolean {
  const value = (process.env.OPENCODE_CLAUDE_DEBUG ?? "").toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function logFilePath(): string {
  const base =
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "opencode-claude", "debug.log");
}

function formatArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) {
    return arg.stack || `${arg.name}: ${arg.message}`;
  }
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function formatLine(level: string, args: unknown[]): string {
  const ts = new Date().toISOString();
  return `${ts} level=${level} ${args.map(formatArg).join(" ")}`;
}

function writeFile(line: string): void {
  try {
    const path = logFilePath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${line}\n`, "utf8");
  } catch {
    // never let logging break the plugin
  }
}

function emit(level: "info" | "warn" | "error", args: unknown[]): void {
  const line = formatLine(level, args);
  const debug = debugEnabled();
  // stderr only on request: inside the TUI it corrupts the screen
  if (debug) console.error(line);
  // durable record so warnings survive without --print-logs
  if (level !== "info" || debug) {
    writeFile(line);
  }
}

export const log = {
  info(...args: unknown[]): void {
    if (!debugEnabled()) return;
    emit("info", args);
  },
  warn(...args: unknown[]): void {
    emit("warn", args);
  },
  error(...args: unknown[]): void {
    emit("error", args);
  },
  /** Absolute path of the durable debug log file. */
  filePath(): string {
    return logFilePath();
  },
};
