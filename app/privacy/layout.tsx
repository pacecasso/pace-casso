import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Privacy",
  description:
    "PaceCasso privacy overview — create-flow drafts stay in your browser; we do not upload your traced photo to our servers.",
};

export default function PrivacyLayout({ children }: { children: ReactNode }) {
  return children;
}
