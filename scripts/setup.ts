import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const envPath = path.join(root, ".env");

let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : fs.readFileSync(path.join(root, ".env.example"), "utf8");
if (!/^AGENT_TOKEN=\S+/m.test(env)) {
  const token = crypto.randomBytes(32).toString("hex");
  env = /^AGENT_TOKEN=/m.test(env) ? env.replace(/^AGENT_TOKEN=.*$/m, `AGENT_TOKEN=${token}`) : `${env.trimEnd()}\nAGENT_TOKEN=${token}\n`;
  fs.writeFileSync(envPath, env, { mode: 0o600 });
  console.log("Wrote a new AGENT_TOKEN to .env");
} else {
  console.log(".env already has an AGENT_TOKEN");
}

for (const dir of ["data/applications", "data/source-docs", "logs"]) fs.mkdirSync(path.join(root, dir), { recursive: true });

execFileSync("npx", ["tsx", "db/seed.ts"], { stdio: "inherit" });
execFileSync("npx", ["tsx", "scripts/import-profile.ts"], { stdio: "inherit" });
console.log("\nNext: put your resume and CV PDFs in data/source-docs/, then `npm run build && npm start`.");
