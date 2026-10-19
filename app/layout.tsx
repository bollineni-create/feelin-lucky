import type { Metadata } from "next";
import { Header } from "@/components/Nav";
import { themeScript } from "@/components/ThemeToggle";
import { activeRun, getProfile, latestRuns, queueItems } from "@/lib/logic";
import "./globals.css";

export const metadata: Metadata = { title: "Job Hunt Command Center" };
export const dynamic = "force-dynamic";

function lastScanText() {
  if (activeRun()) return "Scan running now";
  const last = latestRuns(1)[0];
  if (!last) return "No scan yet";
  const at = new Date(last.finishedAt ?? last.startedAt).toLocaleString("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Los_Angeles",
  });
  return last.status === "ok" ? `Scan finished ${at} PT` : `Last scan failed ${at} PT`;
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const queueCount = queueItems().filter((a) => a.stage === "found").length;
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap" />
      </head>
      <body>
        <Header queueCount={queueCount} lastScan={lastScanText()} owner={getProfile().fullName.split(" ")[0] ?? ""} />
        <main>
          <div className="container">{children}</div>
        </main>
      </body>
    </html>
  );
}
