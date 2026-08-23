import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "tmp-manhattan-grid-design-study");
fs.mkdirSync(outDir, { recursive: true });

const bounds = {
  south: 40.698,
  west: -74.02,
  north: 40.882,
  east: -73.958,
};

const designs = [
  {
    name: "Big Apple Bite",
    idea: "A full-Manhattan apple silhouette: Hudson side as the outer curve, Central Park as the bite, Harlem as the leaf.",
    color: "#148447",
    coords: [
      [40.707, -74.014],
      [40.724, -74.015],
      [40.758, -74.005],
      [40.800, -73.989],
      [40.846, -73.966],
      [40.861, -73.958],
      [40.841, -73.971],
      [40.856, -73.963],
      [40.834, -73.958],
      [40.812, -73.964],
      [40.795, -73.978],
      [40.784, -73.965],
      [40.766, -73.969],
      [40.740, -73.981],
      [40.715, -74.000],
      [40.707, -74.014],
    ],
  },
  {
    name: "Liberty Torch",
    idea: "A torch route: Battery base, Broadway handle, and a flame wrapping the lower edge of Central Park.",
    color: "#e4572e",
    coords: [
      [40.704, -74.014],
      [40.712, -74.004],
      [40.724, -73.999],
      [40.739, -73.991],
      [40.754, -73.981],
      [40.768, -73.974],
      [40.784, -73.966],
      [40.800, -73.958],
      [40.790, -73.973],
      [40.777, -73.982],
      [40.760, -73.979],
      [40.770, -73.965],
      [40.790, -73.958],
    ],
  },
  {
    name: "Interlocking NY",
    idea: "A street-grid monogram: avenue strokes make the N and the split upper arms form a Y through Midtown.",
    color: "#2364aa",
    coords: [
      [40.718, -74.004],
      [40.802, -73.986],
      [40.722, -73.974],
      [40.806, -73.958],
      [40.764, -73.974],
      [40.803, -73.971],
      [40.764, -73.974],
      [40.735, -73.984],
    ],
  },
  {
    name: "Island Lightning",
    idea: "A bold lightning mark using the whole island: uptown point, Midtown notch, downtown strike.",
    color: "#8b3fd1",
    coords: [
      [40.866, -73.958],
      [40.805, -73.989],
      [40.817, -73.964],
      [40.756, -74.006],
      [40.775, -73.973],
      [40.706, -74.012],
    ],
  },
];

function project([lat, lng], width, height) {
  const x = ((lng - bounds.west) / (bounds.east - bounds.west)) * width;
  const y = (1 - (lat - bounds.south) / (bounds.north - bounds.south)) * height;
  return [x, y];
}

function routeLengthKm(coords) {
  let meters = 0;
  for (let i = 1; i < coords.length; i++) {
    const [lat1, lng1] = coords[i - 1];
    const [lat2, lng2] = coords[i];
    const latRad = ((lat1 + lat2) / 2) * (Math.PI / 180);
    const metersPerLat = 111_320;
    const metersPerLng = metersPerLat * Math.cos(latRad);
    meters += Math.hypot(
      (lat2 - lat1) * metersPerLat,
      (lng2 - lng1) * metersPerLng,
    );
  }
  return meters / 1000;
}

function routePath(coords, width, height) {
  return coords
    .map((p, i) => {
      const [x, y] = project(p, width, height);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

function gridLines(width, height) {
  const lines = [];
  for (let i = -6; i < 22; i++) {
    const x1 = i * 55;
    lines.push(`<line x1="${x1}" y1="${height + 80}" x2="${x1 + 430}" y2="-80" class="avenue" />`);
  }
  for (let i = -5; i < 20; i++) {
    const y1 = i * 48;
    lines.push(`<line x1="-80" y1="${y1}" x2="${width + 80}" y2="${y1 + 560}" class="street" />`);
  }
  return lines.join("\n");
}

function routeSvg(design, width = 700, height = 620) {
  const parkA = project([40.800, -73.981], width, height);
  const parkB = project([40.768, -73.958], width, height);
  const d = routePath(design.coords, width, height);
  return `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${design.name}">
      <rect width="${width}" height="${height}" class="water" />
      <path class="island" d="M78 20 C128 80 164 190 150 330 C134 470 162 575 232 650 L480 650 C422 540 390 430 390 285 C390 142 430 56 492 20 Z" />
      <g transform="rotate(-29 ${width / 2} ${height / 2})">${gridLines(width, height)}</g>
      <rect x="${parkA[0].toFixed(1)}" y="${parkA[1].toFixed(1)}" width="${Math.max(16, parkB[0] - parkA[0]).toFixed(1)}" height="${Math.max(16, parkB[1] - parkA[1]).toFixed(1)}" class="park" transform="rotate(29 ${(parkA[0] + parkB[0]) / 2} ${(parkA[1] + parkB[1]) / 2})" />
      <path d="${d}" class="route route-shadow" />
      <path d="${d}" class="route" style="stroke:${design.color}" />
      ${design.coords
        .map((p, i) => {
          const [x, y] = project(p, width, height);
          return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${i === 0 ? 6 : 4}" class="node" style="fill:${design.color}" />`;
        })
        .join("\n")}
    </svg>`;
}

const cards = designs
  .map((design) => {
    const km = routeLengthKm(design.coords);
    return `
      <article class="card">
        <div class="map">${routeSvg(design)}</div>
        <div class="meta">
          <h2>${design.name}</h2>
          <p>${design.idea}</p>
          <div><b>${km.toFixed(1)} km</b> rough sketch distance before street snapping</div>
        </div>
      </article>`;
  })
  .join("\n");

const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Manhattan Grid Design Study</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #15120d;
      --muted: #685f52;
      --line: #ded8cc;
      --paper: #fffaf0;
      --panel: #fffef9;
      --yellow: #ffb800;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--paper);
      color: var(--ink);
      font-family: Arial, Helvetica, sans-serif;
    }
    .page {
      width: 1600px;
      padding: 34px;
    }
    header {
      display: flex;
      align-items: end;
      justify-content: space-between;
      border-bottom: 4px solid var(--yellow);
      padding-bottom: 18px;
      margin-bottom: 26px;
    }
    h1 {
      margin: 0;
      font-size: 38px;
      letter-spacing: 0;
    }
    header p {
      margin: 8px 0 0;
      max-width: 860px;
      color: var(--muted);
      font-size: 18px;
      line-height: 1.4;
    }
    .grid-note {
      text-align: right;
      font-size: 16px;
      color: var(--muted);
      line-height: 1.45;
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 22px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
      min-height: 805px;
      display: flex;
      flex-direction: column;
    }
    .map {
      height: 620px;
      border-bottom: 1px solid var(--line);
      background: #eaf4f6;
    }
    svg { width: 100%; height: 100%; display: block; }
    .water { fill: #b9dbe4; }
    .island { fill: #f4efe3; stroke: #b6aa96; stroke-width: 2; }
    .street { stroke: #ded6c7; stroke-width: 3; }
    .avenue { stroke: #cfc4af; stroke-width: 5; }
    .park { fill: #bfe3bd; stroke: #86b884; stroke-width: 2; opacity: 0.9; }
    .route {
      fill: none;
      stroke-width: 9;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .route-shadow {
      stroke: white;
      stroke-width: 16;
      opacity: 0.78;
    }
    .node {
      stroke: white;
      stroke-width: 3;
    }
    .meta {
      padding: 20px 20px 22px;
    }
    h2 {
      margin: 0 0 10px;
      font-size: 25px;
      letter-spacing: 0;
    }
    p {
      color: var(--muted);
      font-size: 16px;
      line-height: 1.45;
      min-height: 72px;
      margin: 0 0 18px;
    }
    .meta div {
      border-top: 1px solid var(--line);
      padding-top: 14px;
      font-size: 15px;
      color: var(--muted);
      line-height: 1.35;
    }
    b { color: var(--ink); }
  </style>
</head>
<body>
  <main class="page">
    <header>
      <div>
        <h1>Manhattan Grid Design Study</h1>
        <p>Four map-native route ideas made from the city itself: the 29 degree avenue grid, perpendicular crosstown streets, Broadway-like diagonals, Central Park, and the Hudson/East River boundaries.</p>
      </div>
      <div class="grid-note">
        Manhattan preset bounds<br />
        grid bearings: 29 / 119 degrees<br />
        drawn as runnable route concepts, not final snapped GPX
      </div>
    </header>
    <section class="cards">
      ${cards}
    </section>
  </main>
</body>
</html>`;

const htmlPath = path.join(outDir, "manhattan-grid-design-study.html");
const pngPath = path.join(outDir, "manhattan-grid-design-study.png");
fs.writeFileSync(htmlPath, html);

const chromePath =
  process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const browser = await chromium.launch(
  fs.existsSync(chromePath)
    ? { headless: true, executablePath: chromePath }
    : { headless: true },
);
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 980 }, deviceScaleFactor: 1 });
  await page.goto(`file://${htmlPath.replace(/\\/g, "/")}`);
  await page.screenshot({ path: pngPath, fullPage: true });
} finally {
  await browser.close();
}

console.log(`Wrote ${htmlPath}`);
console.log(`Wrote ${pngPath}`);
