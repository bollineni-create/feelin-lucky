// Loads my-profile.json (git-ignored, next to package.json) into the profile, so it never has to be retyped.
// Runs when the app still has the starter profile or the file changed since the profile was last saved,
// so edits made in Settings aren't overwritten by an old file.
// Also copies the source resume/CV PDFs into data/source-docs/ when they sit in this folder or ~/Downloads.
//   npx tsx scripts/import-profile.ts [--force]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb, schema, ROOT, DATA_DIR } from "@/lib/db";

const FILE = path.join(ROOT, "my-profile.json");
const FIELDS = [
  "fullName", "email", "phone", "location", "linkedinUrl", "websiteUrl", "workAuthorization", "needsSponsorship",
  "workHistory", "education", "skills", "resumeFile", "cvFile", "resumeText", "cvText",
] as const;

if (!fs.existsSync(FILE)) {
  console.log("No my-profile.json; fill in the profile under Settings.");
  process.exit(0);
}

const db = getDb();
const current = db.select().from(schema.profile).where(eq(schema.profile.id, 1)).get();
const fileTime = fs.statSync(FILE).mtime.toISOString();
const starter = !current || /\[(CONFIRM|TITLE)[^\]]*\]/i.test(JSON.stringify(current.workHistory));
if (!starter && current.updatedAt > fileTime && !process.argv.includes("--force")) {
  console.log("Profile was saved in the app after my-profile.json last changed; keeping the app's version (--force to reload the file).");
} else {
  const data = JSON.parse(fs.readFileSync(FILE, "utf8")) as Record<string, unknown>;
  const values = Object.fromEntries(FIELDS.filter((k) => k in data).map((k) => [k, data[k]]));
  if (!Array.isArray(values.workHistory)) throw new Error("my-profile.json: workHistory must be a list");
  // "confirmed": true in the file is the user's sign-off; placeholders still block it, as in Settings.
  const confirmed = data.confirmed === true && !/\[(CONFIRM|TITLE)[^\]]*\]/i.test(JSON.stringify(values.workHistory));
  db.update(schema.profile)
    .set({ ...values, confirmed, updatedAt: new Date().toISOString() })
    .where(eq(schema.profile.id, 1))
    .run();
  const criteria = data.criteria as Record<string, unknown> | undefined;
  if (criteria) {
    const keys = ["autoApply", "autoApplySources", "autoApplyMinScore", "autoApplyDailyCap", "minBase"] as const;
    const set = Object.fromEntries(keys.filter((k) => k in criteria).map((k) => [k, criteria[k]]));
    if (Object.keys(set).length) db.update(schema.searchCriteria).set({ ...set, updatedAt: new Date().toISOString() }).where(eq(schema.searchCriteria.id, 1)).run();
  }
  console.log(`Loaded profile for ${values.fullName ?? "you"} from my-profile.json${confirmed ? " (confirmed)" : '. Check it and tick "confirmed" in Settings'}.`);
}

const docs = path.join(DATA_DIR, "source-docs");
fs.mkdirSync(docs, { recursive: true });
const p = db.select().from(schema.profile).where(eq(schema.profile.id, 1)).get()!;
for (const name of [p.resumeFile, p.cvFile]) {
  if (!name || fs.existsSync(path.join(docs, name))) continue;
  const from = [ROOT, path.join(os.homedir(), "Downloads")].map((d) => path.join(d, name)).find((f) => fs.existsSync(f));
  if (from) {
    fs.copyFileSync(from, path.join(docs, name));
    console.log(`Copied ${name} into data/source-docs/.`);
  }
}
