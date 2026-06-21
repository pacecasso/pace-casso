const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const root = path.join(__dirname, "..");
const explicitBaseURL = process.env.PLAYWRIGHT_BASE_URL;
const port = process.env.PORT || "3100";
const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
const playwrightBin = path.join(
  root,
  "node_modules",
  "@playwright",
  "test",
  "cli.js",
);

function waitForServer(url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() > deadline) {
          reject(new Error(`Timed out waiting for ${url}`));
          return;
        }
        setTimeout(tick, 500);
      });
      req.setTimeout(1000, () => {
        req.destroy();
      });
    };
    tick();
  });
}

function canReachServer(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(800, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function stop(child) {
  if (!child || child.killed) return;
  child.kill("SIGTERM");
  setTimeout(() => {
    if (!child.killed) child.kill("SIGKILL");
  }, 2000).unref();
}

(async () => {
  let baseURL = explicitBaseURL || `http://localhost:${port}`;
  let server = null;
  const existingLocalDev = "http://localhost:3000";

  if (!explicitBaseURL && !process.env.PORT && (await canReachServer(existingLocalDev))) {
    baseURL = existingLocalDev;
  } else {
    server = spawn(process.execPath, [nextBin, "dev", "-p", port], {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        NEXT_PUBLIC_MAPBOX_PROXY: process.env.NEXT_PUBLIC_MAPBOX_PROXY ?? "1",
      },
    });
  }

  const stopServer = () => stop(server);
  process.on("SIGINT", () => {
    stopServer();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    stopServer();
    process.exit(143);
  });

  try {
    await waitForServer(baseURL);
    const args = ["test", ...process.argv.slice(2)];
    const testRun = spawn(process.execPath, [playwrightBin, ...args], {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        PLAYWRIGHT_BASE_URL: baseURL,
        PLAYWRIGHT_SKIP_WEB_SERVER: "1",
      },
    });

    const code = await new Promise((resolve) => {
      testRun.on("exit", (exitCode) => resolve(exitCode ?? 1));
    });
    stopServer();
    process.exit(code);
  } catch (err) {
    stopServer();
    console.error(err);
    process.exit(1);
  }
})();
