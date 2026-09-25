import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Draw my logo",
  description: "Upload a logo or a picture and get runnable routes that draw it across New York City streets.",
};

export default function DrawLayout({ children }: { children: ReactNode }) {
  return children;
}
