"use client";

import dynamic from "next/dynamic";

const WorkflowController = dynamic(
  () => import("../../components/WorkflowController"),
  {
    ssr: false,
    loading: () => (
      <div className="flex min-h-screen items-center justify-center bg-pace-warm font-dm text-sm text-pace-muted">
        Loading…
      </div>
    ),
  },
);

export default function CreatePage() {
  return <WorkflowController />;
}
