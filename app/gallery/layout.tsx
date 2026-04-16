import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Gallery",
  description:
    "Route art inspiration — sketch on the map, snap to streets, and run your design. Start creating in PaceCasso.",
};

export default function GalleryLayout({ children }: { children: ReactNode }) {
  return children;
}
