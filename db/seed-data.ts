import type { BroadSearch, Highlight, WorkEntry } from "./schema";

// Spec §8. `*r` red (high priority), `*t` teal, `*b` blue, `*o` orange.
const WATCHLIST: Record<string, string> = {
  Tech: "OpenAI, Anthropic, Perplexity, Microsoft*r, Amazon, Apple*r, Meta, Netflix, Google*t, NVIDIA, AMD, Valve, Uber*r, DoorDash*r, TikTok*r, Rapid7*r, CarGurus*r, SAS, Salesforce",
  Fintech: "Cash App / Block / Square*r, Visa*r, Mastercard, PayPal, Stripe, Plaid*r, Ramp, Robinhood*r, Polymarket, Kalshi, Bilt",
  Finance:
    "JPMorgan Chase*r, BlackRock*r, Lazard, Blackstone*r, Carlyle, Goldman Sachs, PIMCO, Fidelity, Charles Schwab, Vanguard, Bain Capital*r, Loomis Sayles*r, State Street, Morgan Stanley*r, HSBC",
  "Research / market infrastructure": "S&P, Moody's, Dow Jones, Nasdaq, NYSE, LSEG, Morningstar*r, ICE",
  "Hedge funds / trading": "Point72, Citadel*r, Bridgewater*r, Millennium, Jane Street, HRT, Citadel Securities*r",
  Consulting: "FTI, McKinsey, BCG*b, Bain",
  "Think tanks":
    "Pew Research Center, Council on Foreign Relations, Center for American Progress, National Bureau of Economic Research, Hudson Institute",
  Crypto: "Coinbase, Gemini, Ledger, Crypto.com*o",
  Dow: "Procter & Gamble, Travelers, UnitedHealth, Honeywell, Home Depot, IBM, Johnson & Johnson, McDonald's, 3M, Merck, Nike, American Express, Caterpillar, Salesforce, Chevron, Disney, Coca-Cola, Sherwin-Williams, Cisco, Walmart, Amgen",
  Health: "Benaroya*r, Aetna",
  Education: "Harvard*r, UPenn*r, Stanford*r",
  "Government / defense":
    "Blue Origin, SpaceX*r, OECD*t, World Bank*t, UN*t, IMF*t, Palantir*r, Lockheed Martin*r, Anduril*r, RTX*r, Northrop Grumman*r, General Dynamics, BAE Systems, L3Harris, Booz Allen Hamilton*r, U.S. Treasury, Federal Reserve",
  Manufacturing: "Ford, Bentley, Mercedes-Benz, BMW, VW Group, Ferrari, Tesla, Rivian, Lucid, Rolls-Royce",
  Other:
    "Zillow*r, Rocket Homes, Valve, LVMH, T-Mobile, Alaska Airlines*r, Shopify*r, Delta*r, United Airlines*r, Walton Enterprises*r",
};

export const CATEGORIES = Object.keys(WATCHLIST);

const HL: Record<string, Highlight> = { r: "red", t: "teal", b: "blue", o: "orange" };

export type SeedCompany = { name: string; categories: string[]; highlight: Highlight | null };

export function seedCompanies(): SeedCompany[] {
  const byName = new Map<string, SeedCompany>();
  for (const [category, list] of Object.entries(WATCHLIST)) {
    for (const raw of list.split(",").map((s) => s.trim())) {
      const m = raw.match(/^(.*?)(?:\*([rtbo]))?$/)!;
      const name = m[1].trim();
      const highlight = m[2] ? HL[m[2]] : null;
      const existing = byName.get(name);
      if (existing) {
        if (!existing.categories.includes(category)) existing.categories.push(category);
        existing.highlight ??= highlight;
      } else {
        byName.set(name, { name, categories: [category], highlight });
      }
    }
  }
  return [...byName.values()];
}

// From the LinkedIn Job tracker, 2026-10-19.
export const SEED_APPLICATIONS: {
  company: string;
  title: string;
  location: string;
  workMode: "remote" | "hybrid" | "onsite";
  stage: "found" | "closed";
  closedReason?: string;
  linkedinStatus: string;
  note?: string;
}[] = [
  { company: "DoorDash", title: "Associate Manager, Strategy & Operations", location: "Remote", workMode: "remote", stage: "found", linkedinStatus: "saved" },
  { company: "Harris Computer", title: "Corporate Development Associate", location: "Remote", workMode: "remote", stage: "found", linkedinStatus: "saved" },
  { company: "Paylocity", title: "Senior Analyst, Corporate Strategy and Development", location: "Remote", workMode: "remote", stage: "found", linkedinStatus: "saved" },
  { company: "eXp Realty", title: "Associate Financial Analyst", location: "Remote", workMode: "remote", stage: "found", linkedinStatus: "saved" },
  { company: "Figma", title: "Strategic Finance", location: "Remote", workMode: "remote", stage: "found", linkedinStatus: "saved" },
  { company: "Autodesk", title: "Corporate Development Associate", location: "Remote", workMode: "remote", stage: "found", linkedinStatus: "saved" },
  { company: "Clipboard", title: "Senior Associate, Revenue Strategy & Growth", location: "Remote", workMode: "remote", stage: "found", linkedinStatus: "saved" },
  { company: "Origin Staffing", title: "Senior Financial Analyst", location: "Boston (Remote)", workMode: "remote", stage: "closed", closedReason: "posting_closed", linkedinStatus: "applied", note: "Application viewed before the posting closed." },
  { company: "Quik Hire Staffing", title: "Finance Analyst", location: "Remote", workMode: "remote", stage: "closed", closedReason: "posting_closed", linkedinStatus: "applied" },
  { company: "FESI", title: "Corporate & Investment Partnerships Manager", location: "DC (Remote)", workMode: "remote", stage: "closed", closedReason: "posting_closed", linkedinStatus: "applied" },
  { company: "Toyota Research Institute", title: "VC Associate", location: "Remote", workMode: "remote", stage: "closed", closedReason: "posting_closed", linkedinStatus: "applied" },
];

export const SEED_CRITERIA = {
  primaryLocations: ["Seattle, WA", "Boston, MA"],
  secondaryLocations: ["Los Angeles, CA", "Chicago, IL", "Washington, DC"],
  workModes: ["remote", "hybrid", "onsite"],
  functions: [
    "Corporate development",
    "Strategy & operations",
    "Strategic finance",
    "Treasury / payments",
    "Corporate & commercial banking",
    "Fintech product",
    "Fintech partnerships",
  ],
  fitThreshold: 70,
  highPriorityThreshold: 60,
  minBase: null as number | null,
  lookbackDays: 7,
  broadSearches: [
    { label: "All Dow companies", query: "Roles matching the functions at any Dow 30 company" },
    { label: "Remote jobs", query: "Remote roles matching the functions" },
    { label: "Startups", query: "Startup roles matching the functions (Series A–D)" },
    { label: "Growing brands", query: "Fast-growing consumer and tech brands" },
    { label: "Companies with perks: travel, entertainment, luxury goods, government", query: "Employers known for travel, entertainment, luxury-goods or government perks" },
    { label: "Government agencies and military companies", query: "Federal agencies, defense primes and military contractors" },
  ] satisfies BroadSearch[],
  notes:
    "Remote is top priority; hybrid or onsite acceptable. Seattle and Boston first; LA, Chicago and DC also considered. Open beyond treasury.",
};

// Spec §7. Bracketed values are placeholders the user must confirm in Settings before first use.
export const SEED_WORK_HISTORY: WorkEntry[] = [
  {
    employer: "JPMorgan Chase",
    team: "Commercial Banking",
    title: "Senior Associate [TITLE TO USE — CONFIRM]",
    start: "2026-02",
    end: null,
    bullets: ["VP-track Associate program"],
  },
  {
    employer: "JPMorgan Chase",
    team: "Commercial Banking",
    title: "Associate, VP-track Associate program [CONFIRM]",
    start: "2025-08",
    end: "2026-02",
  },
  {
    employer: "JPMorgan Chase",
    team: "Commercial Banking",
    title: "Analyst, Corporate Analyst Development Program [CONFIRM]",
    start: "2023-07",
    end: "2025-08",
  },
  {
    employer: "[CONFIRM THE JUNE 2022 ENTRY]",
    title: "[CONFIRM]",
    start: "2022-06",
    end: "[CONFIRM]",
  },
];
