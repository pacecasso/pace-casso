import { NextResponse } from "next/server";
import {
  getVerifiedRouteBankExport,
  verifiedRouteBankExportToGpx,
} from "../../../../lib/verifiedRouteBankExports";
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
    const verified = getVerifiedRouteBankExport(id);
    if (!verified) {
      return NextResponse.json({ error: "unknown curated run" }, { status: 404 });
    }
    return new NextResponse(verifiedRouteBankExportToGpx(verified), {
      headers: {
        "Content-Type": "application/gpx+xml",
        "Content-Disposition": `attachment; filename="${verified.id}.gpx"`,
        "Cache-Control": "public, max-age=86400",
      },
    });
  }
  return new NextResponse(curatedRunToGpx(run), {
    headers: {
      "Content-Type": "application/gpx+xml",
      "Content-Disposition": `attachment; filename="${run.id}.gpx"`,
      "Cache-Control": "public, max-age=86400",
    },
  });
}
