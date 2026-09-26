"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export function Refresh() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), 10000);
    return () => clearInterval(timer);
  }, [router]);
  return <button className="refresh" onClick={() => { setBusy(true); router.refresh(); setTimeout(() => setBusy(false), 700); }} disabled={busy}>
    <span className="live-dot" /> {busy ? "Обновляю…" : "Обновить"}
  </button>;
}
