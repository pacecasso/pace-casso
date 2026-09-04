import { runStudio, type StudioResult } from "./studioRouteServer";
import { runWowPlacement, type WowPlaceResult, type JudgeMedia } from "./wowPlaceServer";
import { interpretSketch } from "./sketchInterpretServer";
import { runArtistLoop } from "./artistLoopServer";
import type { ArtistLoopRouteResult } from "./artistLoopCore";
import { loadJobRecord, saveJobRecord } from "./routeJobStore";
import { runPaint, type PaintRouteResult } from "./strokePainterServer";
import type { NormalizedPoint } from "./streetGraphTrace";

/**
 * The async route-search job: the same cascade Step 2 runs live (studio →
 * literal placement → redraw rounds → artist loop), executed server-side
 * one bounded stage per invocation so a phone can submit and walk away.
 * Each stage fits one serverless invocation; state persists in the job
 * store between invocations; the step endpoint chains itself until done.
 */

export type RouteJobStage =
  | "paint"
  | "studio"
  | "literal"
  | "redraw"
  | "place"
  | "artist"
  | "finished";

export type RouteJobResult =
  | { kind: "studio"; studio: StudioResult }
  | { kind: "paint"; paint: PaintRouteResult }
  | { kind: "wow"; wow: WowPlaceResult; redrawn: boolean; composite: boolean }
  | { kind: "artist"; artist: ArtistLoopRouteResult }
  | { kind: "none"; message: string };

export type RouteJob = {
  id: string;
  createdAt: number;
  updatedAt: number;
  email: string | null;
  cityId: string;
  cityLabel: string;
  status: "queued" | "running" | "done" | "failed";
  stage: RouteJobStage;
  round: number;
  stageNote: string;
  input: {
    contour: NormalizedPoint[];
    subject: string | null;
    imageBase64: string | null;
    sourceName: string | null;
  };
  /** carried between rounds: best refusal message for the honest ending */
  lastMessage: string | null;
  /**
   * The instant first draft from the stroke painter (stage 0). Shown to the
   * user as soon as it exists and kept as the ending when no later stage
   * clears the judges' bar — the search never ends empty-handed.
   */
  draft?: PaintRouteResult | null;
  /** the current round's interpreted redraw, between its two stages */
  pendingRedraw: {
    contour: NormalizedPoint[];
    subject: string | null;
    composite: boolean;
  } | null;
  result: RouteJobResult | null;
  error: string | null;
  emailedAt: number | null;
  /**
   * Soft lock: while a step invocation is actively working the job it
   * holds a lease; duplicate step fires (watchdog + normal chain racing)
   * back off instead of double-running a stage.
   */
  leaseUntil: number | null;
};

const MAX_ROUNDS = 4;

const ALLOWED_MEDIA = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function parseImage(
  imageBase64: string,
): { data: string; media: JudgeMedia } {
  if (imageBase64.startsWith("data:")) {
    const comma = imageBase64.indexOf(",");
    if (comma !== -1) {
      const media = imageBase64.slice(0, comma).split(":")[1]?.split(";")[0] ?? "image/png";
      return {
        data: imageBase64.slice(comma + 1),
        media: (ALLOWED_MEDIA.has(media) ? media : "image/png") as JudgeMedia,
      };
    }
  }
  return { data: imageBase64, media: "image/png" };
}

export async function loadJob(jobId: string): Promise<RouteJob | null> {
  return loadJobRecord<RouteJob>(jobId);
}

export async function saveJob(job: RouteJob): Promise<void> {
  job.updatedAt = Date.now();
  await saveJobRecord(job.id, job);
}

/**
 * Run ONE stage of the cascade. Returns the saved job; caller decides
 * whether to chain another step (status still "running") or stop.
 * Every stage is individually try/caught: a stage failure moves the
 * cascade forward, never wedges the job.
 */
export async function advanceJob(job: RouteJob): Promise<RouteJob> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    job.status = "failed";
    job.error = "ANTHROPIC_API_KEY not configured on server";
    await saveJob(job);
    return job;
  }
  job.status = "running";
  job.leaseUntil = Date.now() + 330_000;

  try {
    if (job.stage === "paint") {
      job.stageNote = "Drawing a first draft on real streets…";
      await saveJob(job);
      try {
        const paint = await runPaint(
          { contour: job.input.contour, imageBase64: job.input.imageBase64 ?? undefined, cityId: job.cityId },
          () => {},
        );
        if (paint.ok && paint.chain && paint.chain.length >= 8) job.draft = paint;
      } catch {
        /* no draft — the cascade still runs */
      }
      job.stage = "studio";
      await saveJob(job);
      return job;
    }

    if (job.stage === "studio") {
      job.stageNote = "Tracing your shape directly on real streets…";
      await saveJob(job);
      try {
        const studio = await runStudio(
          {
            contour: job.input.contour,
            subject: job.input.subject ?? undefined,
            imageBase64: job.input.imageBase64 ?? undefined,
          },
          () => {},
        );
        if (studio.ok && studio.verified) {
          return finishJob(job, { kind: "studio", studio });
        }
      } catch {
        /* fall through to the next stage */
      }
      job.stage = "literal";
      await saveJob(job);
      return job;
    }

    if (job.stage === "literal") {
      job.stageNote = "Placing your art exactly as drawn…";
      await saveJob(job);
      try {
        const wow = await runWowPlacement({
          apiKey,
          contour: job.input.contour,
          knownSubject: job.input.subject ?? undefined,
        });
        if (wow.picks.length) {
          return finishJob(job, { kind: "wow", wow, redrawn: false, composite: false });
        }
        job.lastMessage = wow.message ?? job.lastMessage;
      } catch {
        /* fall through */
      }
      if (!job.input.imageBase64) {
        return finishJob(job, {
          kind: "none",
          message:
            job.lastMessage ??
            "Nothing cleared the blind judge's bar. Bold, simple shapes work best.",
        });
      }
      job.stage = "redraw";
      job.round = 1;
      await saveJob(job);
      return job;
    }

    if (job.stage === "redraw") {
      job.stageNote = `Street-ready redraw, attempt ${job.round} of ${MAX_ROUNDS}…`;
      job.pendingRedraw = null;
      await saveJob(job);
      try {
        const img = parseImage(job.input.imageBase64!);
        const interp = await interpretSketch({
          apiKey,
          imageBase64: img.data,
          mediaType: img.media,
        });
        if (interp.contour) {
          job.pendingRedraw = {
            contour: interp.contour,
            subject: interp.subject,
            composite: interp.composite,
          };
        } else {
          job.lastMessage = interp.message ?? job.lastMessage;
        }
      } catch {
        /* fall through */
      }
      if (job.pendingRedraw) {
        job.stage = "place";
      } else {
        job.round += 1;
        if (job.round > MAX_ROUNDS) job.stage = "artist";
      }
      await saveJob(job);
      return job;
    }

    if (job.stage === "place") {
      job.stageNote = `Placing redraw ${job.round} of ${MAX_ROUNDS} on real streets…`;
      await saveJob(job);
      const redraw = job.pendingRedraw;
      job.pendingRedraw = null;
      if (redraw) {
        try {
          const img = parseImage(job.input.imageBase64!);
          const wow = await runWowPlacement({
            apiKey,
            contour: redraw.contour,
            knownSubject: redraw.subject ?? undefined,
            originalImage: redraw.composite ? img : undefined,
          });
          if (wow.picks.length) {
            return finishJob(job, {
              kind: "wow",
              wow,
              redrawn: true,
              composite: redraw.composite,
            });
          }
          job.lastMessage = wow.message ?? job.lastMessage;
        } catch {
          /* fall through */
        }
      }
      job.round += 1;
      job.stage = job.round > MAX_ROUNDS ? "artist" : "redraw";
      await saveJob(job);
      return job;
    }

    if (job.stage === "artist") {
      job.stageNote = "Design-first street artist loop…";
      await saveJob(job);
      try {
        const img = parseImage(job.input.imageBase64!);
        const artist = await runArtistLoop({
          imageBase64: img.data,
          mediaType: img.media,
          cityLabel: job.cityLabel,
          sourceName: job.input.sourceName,
          timeBudgetMs: 220_000,
        });
        if (artist) {
          return finishJob(job, { kind: "artist", artist });
        }
      } catch {
        /* fall through */
      }
      return finishJob(job, {
        kind: "none",
        message:
          job.lastMessage ??
          "We tried your art as-drawn, street-ready redraws, and the artist loop — nothing cleared the blind judge's bar.",
      });
    }

    // already finished
    return job;
  } catch (err) {
    job.status = "failed";
    job.error = err instanceof Error ? err.message : String(err);
    await saveJob(job);
    return job;
  }
}

async function finishJob(job: RouteJob, result: RouteJobResult): Promise<RouteJob> {
  if (result.kind === "none" && job.draft?.ok && job.draft.chain) {
    result = { kind: "paint", paint: job.draft };
  }
  job.result = result;
  job.status = "done";
  job.stage = "finished";
  job.leaseUntil = null;
  job.stageNote =
    result.kind === "none" ? "Finished — no route cleared the bar." : "Route found.";
  await saveJob(job);
  return job;
}
