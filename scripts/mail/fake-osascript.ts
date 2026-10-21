// Stands in for /usr/bin/osascript in lib/mail.test.ts (JOBHUNT_OSASCRIPT points at a wrapper that runs this). It runs
// the Mail bridge against fake-mail.ts, keeping Mail's state in the FAKE_MAIL_STATE file between calls, and records
// notifications (osascript -e 'display notification …') in FAKE_MAIL_NOTES.
import fs from "node:fs";
import { dumpState, fakeMail, loadBridge, loadState } from "./fake-mail";

const args = process.argv.slice(2);
if (args[0] === "-e") {
  fs.appendFileSync(process.env.FAKE_MAIL_NOTES!, `${args[1]}\n`);
} else {
  // -l JavaScript <bridge> <json>
  const file = process.env.FAKE_MAIL_STATE!;
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  const state = loadState(JSON.stringify(saved.state));
  const { mail, calls } = fakeMail({ state, running: saved.running, denied: saved.denied });
  const out = loadBridge(mail).run([args[3]]);
  saved.state = JSON.parse(dumpState(state));
  saved.calls = [...(saved.calls ?? []), ...calls];
  fs.writeFileSync(file, JSON.stringify(saved));
  process.stdout.write(`${out}\n`);
}
