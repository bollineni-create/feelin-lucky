// Runs the Mail bridge (scripts/mail/mail.js) against a stand-in for Mail's scripting objects. It checks the bridge's
// own logic: what it reads, in what order, how it files and flags, and how it reports failures. Whether real Mail
// answers the same way is down to the JXA calls themselves, which only a Mac can run; the stand-in copies the
// behaviour others have measured on real Macs (ids that die when a message moves, Gmail keeping a moved message in
// the inbox, Exchange accounts, mailboxes made despite an error).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeMail, loadBridge, type Msg, type Out } from "./fake-mail";

const day = (n: number) => new Date(Date.UTC(2026, 9, n, 12));
const base = { domains: ["greenhouse-mail.io"], terms: ["application", "stripe"], known: [], max_bodies: 10, body_chars: 50, include_junk: true, accounts: [] };
const noShell = () => {};

test("status and list say when Mail isn't running, without touching it", () => {
  const { mail, calls } = fakeMail({ running: false, accounts: [{ name: "iCloud" }] });
  const b = loadBridge(mail);
  assert.deepEqual(b.handle(mail, { cmd: "status" }, noShell), { ok: true, running: false });
  assert.deepEqual(b.handle(mail, { cmd: "list", since: day(1).toISOString() }, noShell), { ok: true, running: false });
  assert.deepEqual(calls, []);
});

test("list reads bodies only of likely job emails, oldest first, per account, skipping known and deleted ones", () => {
  const { mail, calls } = fakeMail({
    accounts: [
      {
        name: "Gmail",
        inbox: [
          { messageId: "a@x", sender: "Stripe <no-reply@us.greenhouse-mail.io>", subject: "Thanks", date: day(12), content: "Thank you for applying to Stripe\r\nand a long tail of text￼" },
          { messageId: "b@x", sender: "Shop <deals@shop.com>", subject: "Sale", date: day(11), content: "50% off" },
          { messageId: "<c@x>", sender: "Jane <jane@ramp.com>", subject: "Your application", date: day(10), content: "Hi" },
          { messageId: "old@x", sender: "x <x@greenhouse-mail.io>", subject: "Old", date: day(1), content: "old" },
          { messageId: "k@x", sender: "x <x@greenhouse-mail.io>", subject: "Known", date: day(13), content: "known" },
          { messageId: "d@x", sender: "x <x@greenhouse-mail.io>", subject: "Deleted copy", date: day(13), content: "gone", deleted: true },
        ],
      },
      { name: "iCloud", junk: [{ messageId: "j@x", sender: "Plaid <no-reply@greenhouse-mail.io>", subject: "Application received", date: day(14), content: "Got it" }] },
    ],
  });
  const out = loadBridge(mail).handle(mail, { ...base, cmd: "list", since: day(5).toISOString(), known: ["<k@x>"] }, noShell);
  assert.equal(out.ok, true);
  assert.deepEqual(out.accounts, ["Gmail", "iCloud"]);
  assert.equal(out.scanned, 6);
  assert.equal(out.newest, day(14).toISOString());
  assert.equal(out.truncated, false);
  assert.deepEqual(out.problems, []);
  assert.deepEqual(
    out.messages.map((m: Out) => [m.message_id, m.account, m.where]),
    [["c@x", "Gmail", "inbox"], ["a@x", "Gmail", "inbox"], ["j@x", "iCloud", "junk"]],
  );
  const a = out.messages[1];
  assert.equal(typeof a.mail_id, "number");
  assert.equal(a.body, "Thank you for applying to Stripe\nand a long tail o");
  assert.equal(calls.includes("check"), false);
});

test("list asks Mail to fetch only when told to", () => {
  const { mail, calls } = fakeMail({ accounts: [{ name: "Gmail" }] });
  loadBridge(mail).handle(mail, { ...base, cmd: "list", since: day(1).toISOString(), fetch: true }, noShell);
  assert.equal(calls[0], "check");
});

test("list reads a big mailbox message by message, by id", () => {
  const filler = Array.from({ length: 2500 }, (_, i) => ({ messageId: `f${i}@x`, date: day(1) }));
  const { mail, calls } = fakeMail({ accounts: [{ name: "Gmail", inbox: [...filler, { messageId: "n@x", sender: "x <x@greenhouse-mail.io>", subject: "s", date: day(20), content: "b" }] }] });
  const out = loadBridge(mail).handle(mail, { ...base, cmd: "list", since: day(10).toISOString() }, noShell);
  assert.deepEqual(out.messages.map((m: Out) => m.message_id), ["n@x"]);
  // One byId for the header fields, one for the body.
  assert.equal(calls.filter((c) => c === "byId").length, 2);
});

test("list stops at max_bodies and keeps the watermark at the last one read", () => {
  const inbox = [1, 2, 3].map((n) => ({ messageId: `${n}@x`, sender: "x <x@greenhouse-mail.io>", subject: "s", date: day(10 + n), content: "b" }));
  const { mail } = fakeMail({ accounts: [{ name: "Gmail", inbox }] });
  const out = loadBridge(mail).handle(mail, { ...base, cmd: "list", since: day(1).toISOString(), max_bodies: 2 }, noShell);
  assert.equal(out.truncated, true);
  assert.deepEqual(out.messages.map((m: Out) => m.message_id), ["1@x", "2@x"]);
  assert.equal(out.newest, day(12).toISOString());
});

test("list reads only the accounts asked for", () => {
  const msg = { sender: "x <x@greenhouse-mail.io>", subject: "s", date: day(10), content: "body" };
  const { mail } = fakeMail({ accounts: [{ name: "Gmail", inbox: [{ ...msg, messageId: "g@x" }] }, { name: "Work", inbox: [{ ...msg, messageId: "w@x" }] }] });
  const out = loadBridge(mail).handle(mail, { ...base, cmd: "list", since: day(1).toISOString(), accounts: ["Gmail"] }, noShell);
  assert.deepEqual(out.messages.map((m: Out) => m.message_id), ["g@x"]);
});

test("list also reads Trash, Archive and your folders, Trash first, never Sent, Drafts or Lodestar, each message once", () => {
  const job = (messageId: string, d: number) => ({ messageId, sender: "x <x@greenhouse-mail.io>", subject: "Your application", date: day(d), content: "body" });
  const { mail } = fakeMail({
    accounts: [
      {
        name: "Gmail",
        inbox: [job("in@x", 10)],
        folders: {
          "All Mail": [job("in@x", 10), job("arch@x", 11)],
          Trash: [job("del@x", 12)],
          Recruiters: [job("mine@x", 13), job("arch@x", 11)],
          "Sent Mail": [job("sent@x", 14)],
          Drafts: [job("draft@x", 14)],
          Lodestar: [job("filed@x", 14)],
        },
      },
    ],
  });
  const b = loadBridge(mail);
  const out = b.handle(mail, { ...base, cmd: "list", since: day(1).toISOString(), include_other: true, mailbox: "Lodestar" }, noShell);
  assert.deepEqual(out.problems, []);
  assert.deepEqual(
    out.messages.map((m: Out) => [m.message_id, m.where]),
    [["in@x", "inbox"], ["arch@x", "archive/All Mail"], ["del@x", "trash/Trash"], ["mine@x", "folder/Recruiters"]],
  );
  // Off, only the inbox (and Junk) as before.
  const off = b.handle(mail, { ...base, cmd: "list", since: day(1).toISOString(), mailbox: "Lodestar" }, noShell);
  assert.deepEqual(off.messages.map((m: Out) => m.message_id), ["in@x"]);
});

test("file moves out of Trash into Lodestar, rescues from Trash to the inbox, and finds a message in your folder to flag", () => {
  const { mail, accts } = fakeMail({ accounts: [{ name: "iCloud", folders: { "Deleted Messages": [{ messageId: "r@x" }, { messageId: "i@x" }], Recruiters: [{ messageId: "f@x" }] } }] });
  const box = (n: string) => accts[0].boxes.find((x) => x.name === n)!;
  const [r, i] = box("Deleted Messages").msgs;
  const f = box("Recruiters").msgs[0];
  const at = (m: Msg, where: string, extra: Out) => ({ message_id: m.messageId, mail_id: m.id, account: "iCloud", where, ...extra });
  const out = loadBridge(mail).handle(
    mail,
    { cmd: "file", mailbox: "Lodestar", actions: [at(r, "trash/Deleted Messages", { move: true }), at(i, "trash/Deleted Messages", { rescue: true, flag: true }), at(f, "folder/Recruiters", { flag: true })] },
    noShell,
  );
  assert.equal(out.results[0].moved_to, "Lodestar");
  assert.equal(out.results[1].rescued, true);
  assert.deepEqual(out.results[2], { message_id: "f@x", flagged: true });
  assert.equal(r.box!.name, "Lodestar");
  assert.equal(i.box!.name, "INBOX");
  assert.equal(i.flagged, true);
  assert.equal(f.box!.name, "Recruiters");
  assert.equal(f.flagged, true);
});

const act = (m: Msg, extra: Out) => ({ message_id: m.messageId, mail_id: m.id, account: m.box!.account.name, where: m.box!.name === "Junk" ? "junk" : "inbox", ...extra });

test("file moves into the mailbox in the message's own account, making it once, and flags", () => {
  const { mail, accts, calls } = fakeMail({ accounts: [{ name: "iCloud", inbox: [{ messageId: "a@x" }, { messageId: "b@x" }, { messageId: "c@x" }] }] });
  const [a, b, c] = accts[0].boxes[0].msgs;
  const out = loadBridge(mail).handle(
    mail,
    { cmd: "file", mailbox: "Lodestar", actions: [act(a, { move: true }), act(b, { move: true }), act(c, { flag: true }), { message_id: "zz@x", mail_id: 999, account: "iCloud", where: "inbox", move: true }] },
    noShell,
  );
  const lodestar = accts[0].boxes.find((x) => x.name === "Lodestar")!;
  assert.deepEqual(out.results, [
    { message_id: "a@x", moved_to: "Lodestar", mail_id: lodestar.msgs[0].id },
    { message_id: "b@x", moved_to: "Lodestar", mail_id: lodestar.msgs[1].id },
    { message_id: "c@x", flagged: true },
    { message_id: "zz@x", gone: true },
  ]);
  assert.deepEqual(lodestar.msgs.map((m) => m.messageId), ["a@x", "b@x"]);
  assert.equal(calls.filter((x) => x === "push").length, 1);
  assert.equal(c.flagged, true);
});

test("file on Gmail: the label is added and the message stays in the inbox, which counts as filed", () => {
  const { mail, accts } = fakeMail({ accounts: [{ name: "Gmail", gmail: true, inbox: [{ messageId: "a@x" }] }] });
  const out = loadBridge(mail).handle(mail, { cmd: "file", mailbox: "Lodestar", actions: [act(accts[0].boxes[0].msgs[0], { move: true, flag: true })] }, noShell);
  const r = out.results[0];
  assert.equal(r.moved_to, "Lodestar");
  assert.equal(r.still_in_inbox, true);
  assert.equal(accts[0].boxes.find((x) => x.name === "Lodestar")!.msgs[0].flagged, true);
});

test("file finds a filed message in the Lodestar mailbox (any case) to unflag it", () => {
  const { mail, accts, calls } = fakeMail({ accounts: [{ name: "iCloud", boxes: ["lodestar"] }] });
  const box = accts[0].boxes.find((b) => b.name === "lodestar")!;
  box.msgs.push({ id: 99, messageId: "f@x", sender: "", subject: "", date: day(3), content: "", flagged: true, junk: false, deleted: false, box });
  const out = loadBridge(mail).handle(mail, { cmd: "file", mailbox: "Lodestar", actions: [{ message_id: "f@x", mail_id: 98, account: "iCloud", where: "Lodestar", flag: false }] }, noShell);
  assert.deepEqual(out.results, [{ message_id: "f@x", flagged: false }]);
  assert.equal(box.msgs[0].flagged, false);
  assert.equal(calls.includes("push"), false);
});

test("file rescues from Junk, and falls back to setting the mailbox when move fails", () => {
  const { mail, accts, calls } = fakeMail({ moveFails: true, accounts: [{ name: "iCloud", junk: [{ messageId: "a@x", junk: true }] }] });
  const m = accts[0].boxes.find((b) => b.name === "Junk")!.msgs[0];
  const out = loadBridge(mail).handle(mail, { cmd: "file", mailbox: "Lodestar", actions: [act(m, { move: true })] }, noShell);
  assert.equal(out.results[0].moved_to, "Lodestar");
  assert.ok(calls.includes("set-mailbox"));
  assert.equal(m.junk, false);
  assert.equal(m.box!.name, "Lodestar");
});

test("file makes the mailbox even when Mail reports an error making it", () => {
  const { mail, accts } = fakeMail({ pushFails: "throw-but-create", accounts: [{ name: "iCloud", inbox: [{ messageId: "a@x" }] }] });
  const out = loadBridge(mail).handle(mail, { cmd: "file", mailbox: "Lodestar", actions: [act(accts[0].boxes[0].msgs[0], { move: true })] }, noShell);
  assert.equal(out.results[0].moved_to, "Lodestar");
});

test("file tries AppleScript next, and says how to fix it when nothing works (once per account)", () => {
  const { mail, accts } = fakeMail({ pushFails: "throw", accounts: [{ name: "Gmail", inbox: [{ messageId: "a@x" }, { messageId: "b@x" }] }] });
  const scripts: { lines: string[]; args: string[] }[] = [];
  const [a, b] = accts[0].boxes[0].msgs;
  const out = loadBridge(mail).handle(mail, { cmd: "file", mailbox: 'Job "Hunt"', actions: [act(a, { move: true }), act(b, { move: true })] }, (lines, args) => scripts.push({ lines, args }));
  assert.equal(scripts.length, 1);
  assert.ok(scripts[0].lines.includes("make new mailbox at end of mailboxes of acct with properties {name:(item 2 of argv)}"));
  assert.deepEqual(scripts[0].args, ["uuid-Gmail", 'Job "Hunt"']);
  assert.match(out.results[0].error, /Couldn't create the "Job "Hunt"" mailbox in Gmail.*Create it in Mail/);
  assert.equal(out.results[1].error, out.results[0].error);
});

test("file only flags in an Exchange account, and skips turned-off accounts", () => {
  const { mail, accts } = fakeMail({ accounts: [{ name: "Work", type: "unknown", inbox: [{ messageId: "a@x" }] }, { name: "Old", enabled: false, inbox: [{ messageId: "b@x" }] }] });
  const out = loadBridge(mail).handle(
    mail,
    { cmd: "file", mailbox: "Lodestar", actions: [act(accts[0].boxes[0].msgs[0], { move: true, flag: true }), act(accts[1].boxes[0].msgs[0], { move: true })] },
    noShell,
  );
  assert.equal(out.results[0].flagged, true);
  assert.match(out.results[0].skipped, /Exchange/);
  assert.match(out.results[1].error, /turned off/);
  assert.equal(accts[0].boxes.some((b) => b.name === "Lodestar"), false);
});

test("run reports bad input and Mail's refusals with their number", () => {
  const b = loadBridge({});
  assert.match(JSON.parse(b.run(["{nope"])).error, /couldn't read/);
  const denied = {
    running: () => true,
    accounts: {
      name() {
        throw Object.assign(new Error("Not authorized to send Apple events to Mail."), { errorNumber: -1743 });
      },
    },
  };
  const out = JSON.parse(loadBridge(denied).run([JSON.stringify({ cmd: "list", since: day(1).toISOString() })]));
  assert.deepEqual(out, { ok: false, error: "Not authorized to send Apple events to Mail.", number: -1743 });
});

test("list leaves out a message whose text Mail can't give yet, so the next check reads it", () => {
  const { mail } = fakeMail({ accounts: [{ name: "Gmail", inbox: [{ messageId: "e@x", sender: "x <x@greenhouse-mail.io>", subject: "s", date: day(10), content: "  " }] }] });
  const out = loadBridge(mail).handle(mail, { ...base, cmd: "list", since: day(1).toISOString() }, noShell);
  assert.deepEqual(out.messages, []);
  assert.equal(out.unread, 1);
});

test("list gives each message its account's id; two accounts can share a name", () => {
  const msg = { sender: "x <x@greenhouse-mail.io>", subject: "s", date: day(10), content: "body" };
  const { mail, accts } = fakeMail({ accounts: [{ name: "Google", inbox: [{ ...msg, messageId: "a@x" }] }, { name: "Google", inbox: [{ ...msg, messageId: "b@x" }] }] });
  accts[1].id = "uuid-Google-2";
  const out = loadBridge(mail).handle(mail, { ...base, cmd: "list", since: day(1).toISOString() }, noShell);
  assert.deepEqual(out.messages.map((m: Out) => [m.message_id, m.account_id]), [["a@x", "uuid-Google"], ["b@x", "uuid-Google-2"]]);
  // Filing the second one makes and uses the mailbox in the second account, not the first.
  const b = accts[1].boxes[0].msgs[0];
  const filed = loadBridge(mail).handle(mail, { cmd: "file", mailbox: "Lodestar", actions: [{ message_id: "b@x", mail_id: b.id, account_id: "uuid-Google-2", account: "Google", where: "inbox", move: true }] }, noShell);
  assert.equal(filed.results[0].moved_to, "Lodestar");
  assert.equal(accts[0].boxes.some((x) => x.name === "Lodestar"), false);
  assert.equal(accts[1].boxes.find((x) => x.name === "Lodestar")!.msgs[0].messageId, "b@x");
});

test("file rescues an interview request from Junk to the inbox, unjunked and flagged", () => {
  const { mail, accts } = fakeMail({ accounts: [{ name: "iCloud", junk: [{ messageId: "i@x", junk: true }] }] });
  const m = accts[0].boxes.find((b) => b.name === "Junk")!.msgs[0];
  const out = loadBridge(mail).handle(mail, { cmd: "file", mailbox: "Lodestar", actions: [act(m, { rescue: true, flag: true })] }, noShell);
  assert.equal(out.results[0].rescued, true);
  assert.equal(typeof out.results[0].mail_id, "number");
  assert.equal(m.box!.name, "INBOX");
  assert.equal(m.junk, false);
  assert.equal(m.flagged, true);
});

test("file calls a message gone only when Mail says it isn't there", () => {
  const { mail, accts } = fakeMail({ accounts: [{ name: "iCloud", inbox: [{ messageId: "a@x" }] }] });
  const m = accts[0].boxes[0].msgs[0];
  const busy = Object.assign(new Error("AppleEvent timed out. (-1712)"), { errorNumber: -1712 });
  const box = mail.inbox.mailboxes()[0] as Out;
  const real = mail.inbox.mailboxes;
  mail.inbox.mailboxes = () => [{ ...box, account: box.account, messages: { ...box.messages, byId: () => { throw busy; } } }];
  const out = loadBridge(mail).handle(mail, { cmd: "file", mailbox: "Lodestar", actions: [act(m, { flag: true })] }, noShell);
  assert.equal(out.results[0].gone, undefined);
  assert.match(out.results[0].error, /timed out/);
  mail.inbox.mailboxes = real;
});
