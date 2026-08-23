import assert from "node:assert/strict";
import { GET } from "../app/api/curated-gpx/[id]/route";

async function readGpx(id: string): Promise<{ status: number; body: string; disposition: string | null }> {
  const res = await GET(new Request(`http://local.test/api/curated-gpx/${id}`), {
    params: Promise.resolve({ id }),
  });
  return {
    status: res.status,
    body: await res.text(),
    disposition: res.headers.get("Content-Disposition"),
  };
}

async function main(): Promise<void> {
// Aug 11 re-verification: only the apple remains an exportable verified
// bank route; demoted subjects (trophy, martini-dc, sneaker, ...) 404.
{
  const res = await readGpx("apple");
  assert.equal(res.status, 200, "apple should export through curated GPX endpoint");
  assert(res.disposition?.includes("apple.gpx"), "apple should set a GPX download filename");
  assert(res.body.includes('creator="PaceCasso verified route bank"'));
  assert(
    (res.body.match(/<trkpt /g) ?? []).length >= 70,
    "apple should export a detailed real route",
  );
}
for (const id of ["trophy", "martini-dc", "sneaker"]) {
  const res = await readGpx(id);
  assert.equal(res.status, 404, `${id} failed re-verification and must no longer export as verified`);
}

// Gallery runs export through the curated endpoint (July 28: the original
// six runs were retired at Ralph's direction — their ids now 404).
const current = await readGpx("catalog-heart");
assert.equal(current.status, 200, "current gallery run ids should export");
assert(current.body.includes("PaceCasso curated run"));
const retired = await readGpx("les-heart");
assert.equal(retired.status, 404, "retired gallery run ids are gone");

const ambiguous = await readGpx("martini");
assert.equal(ambiguous.status, 404, "ambiguous martini id should not hide the DC-only route");

console.log("curatedGpxRouteHandler tests ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
