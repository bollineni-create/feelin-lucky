"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function Nav({ queueCount }: { queueCount: number }) {
  const path = usePathname();
  const items = [
    { href: "/", label: "Pipeline" },
    { href: "/queue", label: "Today's queue", count: queueCount },
    { href: "/companies", label: "Companies" },
    { href: "/settings", label: "Settings" },
  ];
  return (
    <nav className="nav" aria-label="Main">
      {items.map((i) => {
        const active = i.href === "/" ? path === "/" || path.startsWith("/jobs") : path.startsWith(i.href);
        return (
          <Link key={i.href} href={i.href} aria-current={active ? "page" : undefined}>
            {i.label}
            {i.count ? <span className="count">{i.count}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}
