import type { Metadata } from "next";
import type { ReactNode } from "react";
import PlausibleAnalytics from "../components/PlausibleAnalytics";
import { getSiteUrl } from "../lib/siteUrl";
import "./globals.css";
import "leaflet/dist/leaflet.css";

const siteDescription =
  "Sketch a shape on the map or trace a photo, snap it to real streets, tune waypoints, and export GPX for your watch. Your city is your canvas.";

export const metadata: Metadata = {
  metadataBase: new URL(getSiteUrl()),
  title: {
    default: "PaceCasso — Design runnable routes on the map",
    template: "%s · PaceCasso",
  },
  description: siteDescription,
  openGraph: {
    type: "website",
    locale: "en_US",
    siteName: "PaceCasso",
    title: "PaceCasso",
    description: siteDescription,
  },
  twitter: {
    card: "summary_large_image",
    title: "PaceCasso",
    description: siteDescription,
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-pace-warm text-pace-ink antialiased">
        <PlausibleAnalytics />
        {children}
      </body>
    </html>
  );
}
