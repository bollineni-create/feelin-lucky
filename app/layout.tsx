import type { Metadata } from "next";
import Link from "next/link";
import { Nav } from "@/components/Nav";
import { queueItems } from "@/lib/logic";
import "./globals.css";

export const metadata: Metadata = { title: "Job Hunt Command Center" };
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const queueCount = queueItems().filter((a) => a.stage === "found").length;
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap"
        />
      </head>
      <body>
        <header className="topbar">
          <div className="container">
            <Link href="/" className="wordmark">
              <span className="dot" aria-hidden />
              Job Hunt Command Center
            </Link>
            <Nav queueCount={queueCount} />
          </div>
        </header>
        <main>
          <div className="container">{children}</div>
        </main>
      </body>
    </html>
  );
}
