import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Create a route",
  description:
    "Pick a city, trace or draw your shape, snap to walkable streets, fine-tune the line, then export GPX or GeoJSON. Your draft saves in this browser.",
};

export default function CreateLayout({ children }: { children: ReactNode }) {
  return children;
}
