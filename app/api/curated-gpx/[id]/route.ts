import { NextResponse } from "next/server";
import {
  curatedRunToGpx,
  getCuratedRun,
} from "../../../../lib/curatedManhattanRuns";

/** Download a curated Manhattan run as a GPX file. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const run = getCuratedRun(id);
  if (!run) {
    return NextResponse.json({ error: "unknown curated run" }, { status: 404 });
  }
  return new NextResponse(curatedRunToGpx(run), {
    headers: {
      "Content-Type": "application/gpx+xml",
      "Content-Disposition": `attachment; filename="${run.id}.gpx"`,
      "Cache-Control": "public, max-age=86400",
    },
  });
}
