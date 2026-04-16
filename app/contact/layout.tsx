import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Contact",
  description: "Contact PaceCasso for product questions or partnerships.",
};

export default function ContactLayout({ children }: { children: ReactNode }) {
  return children;
}
