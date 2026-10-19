import { count, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { dedupeKey } from "@/lib/dedupe";
import { SEED_APPLICATIONS, SEED_CRITERIA, SEED_WORK_HISTORY, seedCompanies } from "./seed-data";

const db = getDb();
const { companies, jobs, applications, events, searchCriteria, profile } = schema;

const existing = db.select({ n: count() }).from(companies).get()!.n;
if (existing > 0 && !process.argv.includes("--force")) {
  console.log(`Database already has ${existing} companies; skipping seed (pass --force to add missing rows).`);
  process.exit(0);
}

db.transaction((tx) => {
  let added = 0;
  for (const c of seedCompanies()) {
    const res = tx
      .insert(companies)
      .values({ name: c.name, categories: c.categories, highlight: c.highlight, priority: c.highlight === "red" ? "high" : "normal" })
      .onConflictDoNothing()
      .run();
    added += res.changes;
  }
  console.log(`Companies: ${added} added (${seedCompanies().length} unique in seed).`);

  for (const a of SEED_APPLICATIONS) {
    const key = dedupeKey(a.company, a.title, a.location);
    if (tx.select().from(jobs).where(eq(jobs.dedupeKey, key)).get()) continue;
    const company = tx.select().from(companies).where(eq(companies.name, a.company)).get();
    const job = tx
      .insert(jobs)
      .values({
        companyId: company?.id ?? null,
        companyName: a.company,
        source: "linkedin",
        title: a.title,
        location: a.location,
        workMode: a.workMode,
        dedupeKey: key,
        firstSeenAt: "2026-10-19T16:00:00.000Z",
      })
      .returning()
      .get();
    const app = tx
      .insert(applications)
      .values({
        jobId: job.id,
        stage: a.stage,
        closedReason: a.closedReason ?? null,
        linkedinStatus: a.linkedinStatus,
        notes: a.note ?? null,
        stageChangedAt: "2026-10-19T16:00:00.000Z",
      })
      .returning()
      .get();
    tx.insert(events)
      .values({
        applicationId: app.id,
        at: "2026-10-19T16:00:00.000Z",
        type: "note",
        title: `Imported from LinkedIn Job tracker (${a.linkedinStatus})`,
        detail: a.stage === "closed" ? "Posting no longer accepting applications." : null,
        source: "seed",
      })
      .run();
  }
  console.log(`Applications: ${SEED_APPLICATIONS.length} from the LinkedIn tracker.`);

  tx.insert(searchCriteria).values({ id: 1, ...SEED_CRITERIA }).onConflictDoNothing().run();
  tx.insert(profile)
    .values({
      id: 1,
      fullName: "Naren Bollineni",
      workHistory: SEED_WORK_HISTORY,
      education: [],
      skills: [],
      resumeFile: "Bollineni_Naren_Resume_2026_V2.pdf",
      cvFile: "Bollineni_Naren_CV_2026_V2.pdf",
      confirmed: false,
    })
    .onConflictDoNothing()
    .run();
});

console.log("Seed complete.");
