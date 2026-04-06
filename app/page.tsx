import { redirect } from "next/navigation";

/** Marketing landing lives in `public/landing.html` (single-file, agency spec). */
export default function Home() {
  redirect("/landing.html");
}
