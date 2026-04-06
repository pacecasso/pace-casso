import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Help",
  description:
    "Draft saving, Mapbox directions, GPX export, and city coverage for PaceCasso.",
};

export default function HelpLayout({ children }: { children: ReactNode }) {
  return children;
}
