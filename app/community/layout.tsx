import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Community",
  description:
    "Join runners turning streets into art—share your line, get inspired, and see what is next for PaceCasso.",
};

export default function CommunityLayout({ children }: { children: ReactNode }) {
  return children;
}
