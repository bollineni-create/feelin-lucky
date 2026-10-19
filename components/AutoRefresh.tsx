"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Re-fetches the page every `seconds` while mounted, so a running scan's progress shows without a reload. */
export function AutoRefresh({ seconds = 15 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds]);
  return null;
}
