import { ImageResponse } from "next/og";

export const alt = "PaceCasso — Design runnable routes on the map";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          justifyContent: "center",
          backgroundColor: "#f7f4ee",
          backgroundImage:
            "radial-gradient(circle at 1px 1px, rgba(29, 111, 216, 0.08) 1px, transparent 0)",
          backgroundSize: "22px 22px",
          padding: 80,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            marginBottom: 24,
          }}
        >
          <div
            style={{
              width: 12,
              height: 48,
              backgroundColor: "#ffb800",
              borderRadius: 2,
            }}
          />
          <span
            style={{
              fontSize: 28,
              fontWeight: 700,
              letterSpacing: "0.2em",
              color: "#0d0d0d",
              textTransform: "uppercase",
            }}
          >
            PaceCasso
          </span>
        </div>
        <div
          style={{
            fontSize: 56,
            fontWeight: 800,
            lineHeight: 1.05,
            color: "#1d6fd8",
            textTransform: "uppercase",
            letterSpacing: "0.02em",
            maxWidth: 900,
          }}
        >
          Your city is your canvas
        </div>
        <div
          style={{
            marginTop: 28,
            fontSize: 26,
            color: "#666666",
            maxWidth: 820,
            lineHeight: 1.4,
          }}
        >
          Trace a shape, snap to streets, export GPX for your watch.
        </div>
        <div
          style={{
            marginTop: 48,
            fontSize: 20,
            fontWeight: 700,
            letterSpacing: "0.25em",
            color: "#ffb800",
            textTransform: "uppercase",
          }}
        >
          Design · Run · Repeat
        </div>
      </div>
    ),
    { ...size },
  );
}
