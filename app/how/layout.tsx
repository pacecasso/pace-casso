import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "Design your route on the map, snap it to runnable streets, fine-tune waypoints, export GPX for your watch, then share your line.",
};

export default function HowLayout({ children }: { children: ReactNode }) {
  return children;
}
