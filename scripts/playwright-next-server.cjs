const { spawn } = require("node:child_process");
const path = require("node:path");

const nextBin = path.join(__dirname, "..", "node_modules", "next", "dist", "bin", "next");
const child = spawn(process.execPath, [nextBin, "dev"], {
  cwd: path.join(__dirname, ".."),
  stdio: "inherit",
  env: process.env,
});

let stopping = false;

function stop(signal) {
  if (stopping) return;
  stopping = true;
  if (!child.killed) child.kill(signal);
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

child.on("exit", (code, signal) => {
  if (stopping) process.exit(0);
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
