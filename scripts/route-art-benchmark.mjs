import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const normalizedRoot = root;
const outputRoot = path.join(normalizedRoot, "tmp-route-art-benchmark");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(outputRoot, stamp);
const fixtureDir = path.join(outDir, "fixtures");
const port = process.env.PORT || "3101";
const caseGapMs = Number(process.env.BENCHMARK_CASE_GAP_MS ?? "6000");
const explicitBaseURL = process.env.BENCHMARK_BASE_URL;
const nextBin = path.join(
  normalizedRoot,
  "node_modules",
  "next",
  "dist",
  "bin",
  "next",
);

fs.mkdirSync(fixtureDir, { recursive: true });

const glyphs = {
  A: [[0, 1], [0.5, 0], [1, 1], [0.75, 0.58], [0.25, 0.58]],
  B: [[0, 1], [0, 0], [0.9, 0], [0.9, 0.48], [0, 0.48], [0.95, 0.48], [0.95, 1], [0, 1]],
  C: [[1, 0], [0, 0], [0, 1], [1, 1]],
  D: [[0, 1], [0, 0], [0.95, 0], [1, 1], [0, 1]],
  E: [[1, 0], [0, 0], [0, 0.5], [0.75, 0.5], [0, 0.5], [0, 1], [1, 1]],
  F: [[0, 1], [0, 0], [1, 0], [0, 0], [0, 0.5], [0.78, 0.5]],
  G: [[1, 0], [0, 0], [0, 1], [1, 1], [1, 0.58], [0.55, 0.58]],
  H: [[0, 0], [0, 1], [0, 0.5], [1, 0.5], [1, 0], [1, 1]],
  I: [[0.1, 0], [0.9, 0], [0.5, 0], [0.5, 1], [0.1, 1], [0.9, 1]],
  J: [[1, 0], [1, 0.82], [0.75, 1], [0.25, 1], [0, 0.82]],
  K: [[0, 1], [0, 0], [0, 0.5], [1, 0], [0, 0.5], [1, 1]],
  L: [[0, 0], [0, 1], [1, 1]],
  M: [[0, 1], [0, 0], [0.5, 0.45], [1, 0], [1, 1]],
  N: [[0, 1], [0, 0], [0.55, 0], [0.55, 1], [1, 1], [1, 0]],
  O: [[0, 1], [0, 0], [1, 0], [1, 1], [0, 1]],
  P: [[0, 1], [0, 0], [0.9, 0], [0.9, 0.52], [0, 0.52]],
  Q: [[0, 1], [0, 0], [1, 0], [1, 1], [0, 1], [0.58, 0.58], [1, 1]],
  R: [[0, 1], [0, 0], [0.78, 0], [0.92, 0.25], [0.78, 0.5], [0, 0.5], [0.56, 0.5], [1, 1]],
  S: [[1, 0], [0, 0], [0, 0.5], [1, 0.5], [1, 1], [0, 1]],
  T: [[0, 0], [1, 0], [0.5, 0], [0.5, 1]],
  U: [[0, 0], [0, 0.82], [0.25, 1], [0.75, 1], [1, 0.82], [1, 0]],
  V: [[0, 0], [0.5, 1], [1, 0]],
  W: [[0, 0], [0.18, 1], [0.5, 0.55], [0.82, 1], [1, 0]],
  X: [[0, 0], [1, 1], [0.5, 0.5], [1, 0], [0, 1]],
  Y: [[0, 0], [0.5, 0.48], [1, 0], [0.5, 0.48], [0.5, 1]],
  Z: [[0, 0], [1, 0], [0, 1], [1, 1]],
};

function wordFixtureSvg(word) {
  const advance = 1.35;
  const points = [];
  for (let i = 0; i < word.length; i++) {
    const glyph = glyphs[word[i]] ?? glyphs.A;
    const ox = i * advance;
    for (const [x, y] of glyph) points.push([ox + x, y]);
    points.push([ox + 1, 1]);
  }
  const width = Math.max(1, word.length * advance);
  const d = points
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${(x * 70 + 12).toFixed(1)} ${(y * 70 + 10).toFixed(1)}`)
    .join(" ");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${(width * 70 + 24).toFixed(0)} 92"><path d="${d}" fill="none" stroke="#111" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

const svgFixtures = {
  "star.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="none" stroke="#111" stroke-width="8" stroke-linejoin="round" d="M50 8 61 37 92 38 67 57 76 88 50 70 24 88 33 57 8 38 39 37Z"/></svg>`,
  "heart.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 92"><path fill="none" stroke="#111" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" d="M50 84 C20 58 8 44 10 26 C12 11 28 6 41 18 C45 22 48 26 50 31 C52 26 55 22 59 18 C72 6 88 11 90 26 C92 44 80 58 50 84 Z"/></svg>`,
  "swoosh.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 80"><path fill="#111" d="M7 56c26 11 63-6 143-49-43 38-83 70-121 70-13 0-22-7-22-21Z"/></svg>`,
  "bolt.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 90 120"><path fill="#111" d="M52 4 12 63h29L28 116l50-69H48Z"/></svg>`,
  "arrow.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 80"><path fill="none" stroke="#111" stroke-width="10" stroke-linecap="round" stroke-linejoin="round" d="M10 48 H100 M78 18 120 48 78 72"/></svg>`,
  "crown.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 90"><path fill="none" stroke="#111" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" d="M12 74 24 26 52 55 70 12 88 55 116 26 128 74 Z"/></svg>`,
  "wave.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 80"><path fill="none" stroke="#111" stroke-width="10" stroke-linecap="round" stroke-linejoin="round" d="M8 52 C30 18 52 18 74 52 S118 86 152 30"/></svg>`,
  "smile.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80"><path fill="none" stroke="#111" stroke-width="8" stroke-linecap="round" d="M25 28h1 M95 28h1 M24 42 C40 70 80 70 96 42"/></svg>`,
  "shield.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 110 130"><path fill="none" stroke="#111" stroke-width="9" stroke-linejoin="round" d="M55 8 98 26 90 78 55 120 20 78 12 26 Z"/></svg>`,
  "diamond.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 110 110"><path fill="none" stroke="#111" stroke-width="9" stroke-linejoin="round" d="M55 6 104 55 55 104 6 55 Z M24 55 H86 M55 6 72 55 55 104 38 55 Z"/></svg>`,
  "checkmark.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 130 90"><path fill="none" stroke="#111" stroke-width="12" stroke-linecap="round" stroke-linejoin="round" d="M12 48 44 78 118 12"/></svg>`,
  "house.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 130 120"><path fill="none" stroke="#111" stroke-width="9" stroke-linejoin="round" d="M14 62 65 16 116 62 104 62 104 108 78 108 78 76 52 76 52 108 26 108 26 62 Z"/></svg>`,
  "mountain.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 150 90"><path fill="none" stroke="#111" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" d="M8 76 42 28 64 56 84 12 142 76 Z"/></svg>`,
  "flower.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 130 130"><path fill="none" stroke="#111" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" d="M65 65 C42 38 54 14 65 34 C76 14 88 38 65 65 C92 42 116 54 96 65 C116 76 92 88 65 65 C88 92 76 116 65 96 C54 116 42 92 65 65 C38 88 14 76 34 65 C14 54 38 42 65 65 Z M65 65 V120"/></svg>`,
  "ralph.svg": wordFixtureSvg("RALPH"),
  "lauren.svg": wordFixtureSvg("LAUREN"),
  "max.svg": wordFixtureSvg("MAX"),
  "mia.svg": wordFixtureSvg("MIA"),
  "maya.svg": wordFixtureSvg("MAYA"),
  "alex.svg": wordFixtureSvg("ALEX"),
  "nora.svg": wordFixtureSvg("NORA"),
  "quinn.svg": wordFixtureSvg("QUINN"),
  "jordan.svg": wordFixtureSvg("JORDAN"),
  "sophia.svg": wordFixtureSvg("SOPHIA"),
  "victor.svg": wordFixtureSvg("VICTOR"),
  "zoe.svg": wordFixtureSvg("ZOE"),
};

for (const [name, svg] of Object.entries(svgFixtures)) {
  fs.writeFileSync(path.join(fixtureDir, name), svg);
}

const only = new Set(
  (process.env.BENCHMARK_ONLY ?? "")
    .split(",")
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean),
);

const candidates = [
  { id: "gas", family: "reference-logo", file: path.join(normalizedRoot, "gas.png"), targetKm: "10" },
  { id: "love", family: "reference-wordmark", file: path.join(normalizedRoot, "LOVE.png"), targetKm: "9" },
  { id: "tiger", family: "reference-mascot", file: path.join(normalizedRoot, "TIGER.webp"), targetKm: "11" },
  { id: "lion", family: "reference-mascot", file: path.join(normalizedRoot, "lion.webp"), targetKm: "11" },
  { id: "star", family: "closed-icon", file: path.join(fixtureDir, "star.svg"), targetKm: "8" },
  { id: "heart", family: "closed-icon", file: path.join(fixtureDir, "heart.svg"), targetKm: "8" },
  { id: "shield", family: "closed-icon", file: path.join(fixtureDir, "shield.svg"), targetKm: "8" },
  { id: "diamond", family: "closed-icon", file: path.join(fixtureDir, "diamond.svg"), targetKm: "8" },
  { id: "crown", family: "closed-icon", file: path.join(fixtureDir, "crown.svg"), targetKm: "9" },
  { id: "swoosh", family: "open-mark", file: path.join(fixtureDir, "swoosh.svg"), targetKm: "8" },
  { id: "bolt", family: "open-mark", file: path.join(fixtureDir, "bolt.svg"), targetKm: "8" },
  { id: "arrow", family: "open-mark", file: path.join(fixtureDir, "arrow.svg"), targetKm: "8" },
  { id: "wave", family: "open-mark", file: path.join(fixtureDir, "wave.svg"), targetKm: "8" },
  { id: "checkmark", family: "open-mark", file: path.join(fixtureDir, "checkmark.svg"), targetKm: "7" },
  { id: "smile", family: "simple-drawing", file: path.join(fixtureDir, "smile.svg"), targetKm: "8" },
  { id: "house", family: "simple-drawing", file: path.join(fixtureDir, "house.svg"), targetKm: "9" },
  { id: "mountain", family: "simple-drawing", file: path.join(fixtureDir, "mountain.svg"), targetKm: "8" },
  { id: "flower", family: "simple-drawing", file: path.join(fixtureDir, "flower.svg"), targetKm: "9" },
  { id: "ralph", family: "reference-wordmark", file: path.join(fixtureDir, "ralph.svg"), targetKm: "9" },
  { id: "lauren", family: "reference-wordmark", file: path.join(fixtureDir, "lauren.svg"), targetKm: "9" },
  { id: "zoe", family: "short-name", file: path.join(fixtureDir, "zoe.svg"), targetKm: "7" },
  { id: "max", family: "short-name", file: path.join(fixtureDir, "max.svg"), targetKm: "7" },
  { id: "mia", family: "short-name", file: path.join(fixtureDir, "mia.svg"), targetKm: "7" },
  { id: "maya", family: "medium-name", file: path.join(fixtureDir, "maya.svg"), targetKm: "8" },
  { id: "alex", family: "medium-name", file: path.join(fixtureDir, "alex.svg"), targetKm: "8" },
  { id: "nora", family: "medium-name", file: path.join(fixtureDir, "nora.svg"), targetKm: "8" },
  { id: "quinn", family: "medium-name", file: path.join(fixtureDir, "quinn.svg"), targetKm: "8" },
  { id: "jordan", family: "long-name", file: path.join(fixtureDir, "jordan.svg"), targetKm: "9" },
  { id: "sophia", family: "long-name", file: path.join(fixtureDir, "sophia.svg"), targetKm: "9" },
  { id: "victor", family: "long-name", file: path.join(fixtureDir, "victor.svg"), targetKm: "9" },
].filter((entry) => fs.existsSync(entry.file) && (only.size === 0 || only.has(entry.id)));

function requestURL(url, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function waitForServer(url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (await requestURL(url)) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`Timed out waiting for ${url}`));
        return;
      }
      setTimeout(tick, 500);
    };
    tick();
  });
}

function stopServer(server) {
  if (!server || server.killed) return;
  server.kill("SIGTERM");
  setTimeout(() => {
    if (!server.killed) server.kill("SIGKILL");
  }, 2000).unref();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveBaseURL() {
  if (explicitBaseURL) return { baseURL: explicitBaseURL, server: null };
  if (await requestURL("http://localhost:3000")) {
    return { baseURL: "http://localhost:3000", server: null };
  }
  const baseURL = `http://localhost:${port}`;
  const server = spawn(process.execPath, [nextBin, "dev", "-p", port], {
    cwd: normalizedRoot,
    stdio: "inherit",
    env: process.env,
  });
  await waitForServer(baseURL);
  return { baseURL, server };
}

function browserLaunchOptions() {
  const chromePath =
    process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
  return fs.existsSync(chromePath)
    ? { headless: true, executablePath: chromePath }
    : { headless: true };
}

async function runBenchmarkCase(page, baseURL, entry) {
  const prefix = `${entry.id}-${entry.targetKm}km`;
  const screenshotPath = path.join(outDir, `${prefix}-options.png`);
  const result = {
    id: entry.id,
    family: entry.family,
    file: path.relative(normalizedRoot, entry.file),
    targetKm: entry.targetKm,
    screenshot: path.relative(outDir, screenshotPath),
    optionCount: 0,
    optionScores: [],
    bestShapeMatch: null,
    bestArtMatch: null,
    bestCleanLine: null,
    summary: "",
    error: "",
  };

  try {
    await page.goto(`${baseURL}/create`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /^Continue\b/ }).click();
    await page.getByRole("button", { name: /From a photo/i }).click();
    await page.locator('input[type="file"]').setInputFiles(entry.file);

    const nextButton = page.getByRole("button", { name: /Next: place on map/i });
    await nextButton.waitFor({ state: "visible", timeout: 120_000 });
    await nextButton.click();

    const approveSketch = page.getByText("Approve sketch").first();
    if (
      await approveSketch
        .waitFor({ state: "visible", timeout: 5000 })
        .then(() => true)
        .catch(() => false)
    ) {
      const useSketchButton = page
        .getByRole("button")
        .filter({ hasText: "Use sketch" })
        .last();
      await useSketchButton.waitFor({ state: "visible", timeout: 120_000 });
      await useSketchButton.click();
    }

    await page.getByText("Place on map").first().waitFor({
      state: "visible",
      timeout: 120_000,
    });
    await page.locator("#target-distance").fill(entry.targetKm);
    await page.getByRole("button", { name: /Auto-find placement/i }).click();
    await page
      .getByRole("button", { name: /Auto-find placement/i })
      .waitFor({ state: "visible", timeout: 360_000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const optionCards = page.locator("button").filter({ hasText: /Shape match/i });
    result.optionCount = await optionCards.count();
    const optionTexts = await optionCards
      .evaluateAll((nodes) => nodes.slice(0, 5).map((node) => node.textContent ?? ""))
      .catch(() => []);
    result.optionScores = optionTexts.map((text) => {
      const shape = text.match(/Shape match\s+(\d+)%/i)?.[1];
      const art = text.match(/Art match\s+(\d+)%/i)?.[1];
      const clean = text.match(/Clean line\s+(\d+)%/i)?.[1];
      return {
        shapeMatch: shape == null ? null : Number(shape),
        artMatch: art == null ? null : Number(art),
        cleanLine: clean == null ? null : Number(clean),
      };
    });
    const finiteScores = (key) =>
      result.optionScores
        .map((score) => score[key])
        .filter((score) => Number.isFinite(score));
    const shapes = finiteScores("shapeMatch");
    const artMatches = finiteScores("artMatch");
    const cleanLines = finiteScores("cleanLine");
    result.bestShapeMatch = shapes.length ? Math.max(...shapes) : null;
    result.bestArtMatch = artMatches.length ? Math.max(...artMatches) : null;
    result.bestCleanLine = cleanLines.length ? Math.max(...cleanLines) : null;
    const body = await page.locator("body").innerText();
    result.summary =
      body.match(/PaceCasso top picks[\s\S]{0,1600}|Candidates[\s\S]{0,1600}/i)?.[0] ??
      body.slice(0, 1600);
  } catch (err) {
    const errorPath = path.join(outDir, `${prefix}-error.png`);
    result.error = err instanceof Error ? err.message : String(err);
    result.screenshot = path.relative(outDir, errorPath);
    await page.screenshot({
      path: errorPath,
      fullPage: true,
    }).catch(() => {});
  }

  return result;
}

function automatedVerdict(result) {
  if (result.error) return "FAIL: run error";
  if (result.optionCount <= 0) return "FAIL: no route";
  if (result.summary.includes("No viable placements found")) {
    return "FAIL: no viable placement";
  }
  if (result.bestArtMatch != null && result.bestArtMatch < 58) {
    return "FAIL: low art match";
  }
  if (result.bestShapeMatch != null && result.bestShapeMatch < 72) {
    return "FAIL: low shape match";
  }
  if (result.bestCleanLine != null && result.bestCleanLine < 50) {
    return "FAIL: messy route";
  }
  if (result.optionCount < 3) return "REVIEW: thin set";
  if (result.bestArtMatch == null || result.bestShapeMatch == null) {
    return "REVIEW: missing score parse";
  }
  return "VISUAL REVIEW";
}

function writeReport(results) {
  fs.writeFileSync(
    path.join(outDir, "results.json"),
    JSON.stringify({ createdAt: new Date().toISOString(), results }, null, 2),
  );

  const lines = [
    "# Route Art Benchmark",
    "",
    "Use this as a visual truth table: each row should be recognizable and runnable, not merely clean.",
    "",
    "Verdict is intentionally conservative: option count is automatic, but every screenshot still needs human visual review for recognizable art.",
    "",
    "| Family | Case | Options | Best art | Best shape | Best clean | Verdict | Screenshot | Notes |",
    "|---|---|---:|---:|---:|---:|---|---|---|",
  ];
  for (const r of results) {
    const verdict = automatedVerdict(r);
    const notes = r.error
      ? `FAILED: ${r.error.replace(/\|/g, "\\|")}`
      : r.summary.replace(/\s+/g, " ").slice(0, 220).replace(/\|/g, "\\|");
    lines.push(
      `| ${r.family ?? "unknown"} | ${r.id} | ${r.optionCount} | ${r.bestArtMatch ?? ""} | ${r.bestShapeMatch ?? ""} | ${r.bestCleanLine ?? ""} | ${verdict} | [open](${r.screenshot.replace(/\\/g, "/")}) | ${notes} |`,
    );
  }
  fs.writeFileSync(path.join(outDir, "summary.md"), `${lines.join("\n")}\n`);
}

const { baseURL, server } = await resolveBaseURL();
const browser = await chromium.launch(browserLaunchOptions());

try {
  const results = [];
  for (const entry of candidates) {
    console.log(`benchmarking ${entry.id} from ${entry.file}`);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 950 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(120_000);
    page.on("console", (msg) => console.log(`[browser:${msg.type()}] ${msg.text()}`));
    page.on("pageerror", (err) => console.log(`[browser:error] ${err.message}`));
    try {
      results.push(await runBenchmarkCase(page, baseURL, entry));
    } finally {
      await context.close();
    }
    if (caseGapMs > 0) await wait(caseGapMs);
  }
  writeReport(results);
  console.log(`route-art benchmark written to ${outDir}`);
} finally {
  await browser.close();
  stopServer(server);
}
