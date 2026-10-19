"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "./ThemeToggle";

export function Header({ queueCount, lastScan, owner }: { queueCount: number; lastScan: string; owner: string }) {
  const path = usePathname();
  const items = [
    { href: "/", label: "Pipeline" },
    { href: "/queue", label: "Today's queue", count: queueCount },
    { href: "/companies", label: "Companies" },
    { href: "/settings", label: "Settings" },
  ];
  const isActive = (href: string) => (href === "/" ? path === "/" || path.startsWith("/jobs") : path.startsWith(href));
  const status = path.startsWith("/queue")
    ? lastScan
    : path.startsWith("/companies")
      ? "Red daily, others every 3 days · careers sites + LinkedIn"
      : "Agent scans weekdays · 7:00 AM PT";

  return (
    <header className="topbar">
      <div className="container">
        <Link href="/" className="wordmark">
          JOB HUNT{owner ? ` / ${owner.toUpperCase()}` : ""}
        </Link>
        <nav className="nav" aria-label="Sections">
          {items.map((i) => (
            <Link key={i.href} href={i.href} aria-current={isActive(i.href) ? "page" : undefined}>
              {i.label}
              {i.count ? <span className="count">({i.count})</span> : null}
            </Link>
          ))}
        </nav>
        <div className="status-line">
          {path.startsWith("/companies") ? null : <span className={`dot ${path.startsWith("/queue") && /failed/.test(lastScan) ? "warn" : ""}`} aria-hidden />}
          <span>{status}</span>
        </div>
        <ThemeToggle />
      </div>
    </header>
  );
}
