// A stand-in for Apple Mail's scripting objects, for testing the bridge (scripts/mail/mail.js) without a Mac. It
// copies behaviour others have measured on real Macs: ids that die when a message moves, Gmail keeping a moved
// message in the inbox, Exchange accounts, mailboxes made despite an error, -1743 when macOS says no.
// scripts/mail/mail.test.ts drives the bridge with it directly; lib/mail.test.ts through fake-osascript.ts, which
// keeps its state in a JSON file between calls.
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(path.join(__dirname, "mail.js"), "utf8");
export type Out = Record<string, any>;
export function loadBridge(app: unknown) {
  const Application = Object.assign(() => app, { currentApplication: () => ({ doShellScript: () => "" }) });
  return new Function("Application", "delay", `${src}\nreturn { run: run, handle: handle };`)(Application, () => {}) as {
    run: (argv: string[]) => string;
    handle: (mail: unknown, input: Out, sh: (lines: string[], args: string[]) => void) => Out;
  };
}

export type Msg = { id: number; messageId: string; sender: string; subject: string; date: Date; content: string; flagged: boolean; junk: boolean; deleted: boolean; box?: Box };
export type Box = { name: string; account: Acct; msgs: Msg[] };
export type Acct = { name: string; id: string; type: string; enabled: boolean; gmail: boolean; boxes: Box[] };
export type AcctSpec = { name: string; type?: string; enabled?: boolean; gmail?: boolean; inbox?: Partial<Msg>[]; junk?: Partial<Msg>[]; boxes?: string[] };

// Like Object.assign onto a function, but also for keys functions already have (`name`, `length`).
const callable = <T extends object>(fn: (...a: any[]) => any, props: T) => {
  for (const [k, v] of Object.entries(props)) Object.defineProperty(fn, k, { value: v, configurable: true });
  return fn as typeof fn & T;
};
const notFound = () => Object.assign(new Error("Can't get object. (-1728)"), { errorNumber: -1728 });

export type FakeOptions = { running?: boolean; denied?: boolean; pushFails?: "throw" | "throw-but-create" | "silent"; moveFails?: boolean };

/** Accounts and their messages from a short description. */
export function buildAccounts(specs: AcctSpec[], firstId = 1): { accts: Acct[]; nextId: number } {
  let nextId = firstId;
  const accts: Acct[] = specs.map((a) => {
    const acct: Acct = { name: a.name, id: `uuid-${a.name}`, type: a.type ?? "imap", enabled: a.enabled ?? true, gmail: a.gmail ?? false, boxes: [] };
    const box = (name: string, msgs: Partial<Msg>[] = []) => {
      const b: Box = { name, account: acct, msgs: [] };
      b.msgs = msgs.map((m) => ({ id: nextId++, messageId: `m${nextId}@x`, sender: "x@y.com", subject: "", date: new Date(), content: "", flagged: false, junk: false, deleted: false, ...m, box: b }));
      acct.boxes.push(b);
    };
    box("INBOX", a.inbox);
    box("Junk", a.junk);
    (a.boxes ?? []).forEach((n) => box(n));
    return acct;
  });
  return { accts, nextId };
}

export function fakeMail(opts: FakeOptions & { accounts?: AcctSpec[]; state?: { accts: Acct[]; nextId: number } }) {
  const state = opts.state ?? buildAccounts(opts.accounts ?? []);
  const accts = state.accts;
  const calls: string[] = [];
  const denied = () => {
    if (opts.denied) throw Object.assign(new Error("Not authorized to send Apple events to Mail. (-1743)"), { errorNumber: -1743 });
  };
  const inboxOf = (a: Acct) => a.boxes.find((b) => b.name === "INBOX")!;

  const moveMsg = (m: Msg, to: Box) => {
    if (to.account.gmail && m.box === inboxOf(to.account)) {
      // Gmail: the label is added, the message stays in the inbox (a copy with its own id).
      to.msgs.push({ ...m, id: state.nextId++, box: to });
      return;
    }
    m.box!.msgs = m.box!.msgs.filter((x) => x !== m);
    m.id = state.nextId++;
    to.msgs.push(m);
    m.box = to;
  };
  // A message as reached through a mailbox: it resolves only while it's still there.
  const wrap = (m: Msg, via: Box): Out => {
    const live = () => {
      if (!via.msgs.includes(m)) throw notFound();
      return m;
    };
    const o: Out = {
      _m: m,
      id: () => live().id,
      messageId: () => live().messageId,
      sender: () => live().sender,
      subject: () => live().subject,
      dateReceived: () => live().date,
      deletedStatus: () => live().deleted,
      content: () => live().content,
    };
    Object.defineProperty(o, "mailbox", { get: () => () => boxObj(live().box!), set: (b: Out) => (calls.push("set-mailbox"), moveMsg(live(), b._box)) });
    Object.defineProperty(o, "flaggedStatus", { get: () => () => live().flagged, set: (v: boolean) => (live().flagged = v) });
    Object.defineProperty(o, "junkMailStatus", { get: () => () => live().junk, set: (v: boolean) => (live().junk = v) });
    return o;
  };
  const messages = (b: Box) => ({
    get length() {
      return b.msgs.length;
    },
    whose(q: Out) {
      const match = (m: Msg) => {
        if (q.dateReceived) return m.date > q.dateReceived._greaterThan;
        if (q._or) return q._or.some((c: Out) => c.messageId === m.messageId);
        return q.messageId === m.messageId;
      };
      const sel = () => b.msgs.filter(match);
      return callable(() => sel().map((m) => wrap(m, b)), {
        id: () => sel().map((m) => m.id),
        messageId: () => sel().map((m) => m.messageId),
        sender: () => sel().map((m) => m.sender),
        subject: () => sel().map((m) => m.subject),
        dateReceived: () => sel().map((m) => m.date),
        deletedStatus: () => sel().map((m) => m.deleted),
      });
    },
    byId(id: number) {
      calls.push("byId");
      const m = b.msgs.find((x) => x.id === id);
      if (!m) throw notFound();
      return wrap(m, b);
    },
  });
  const boxObj = (b: Box): Out => ({ _box: b, name: () => b.name, account: () => acctObj(b.account), messages: messages(b) });
  const acctObj = (a: Acct): Out => {
    const mailboxes: Out = {
      name: () => a.boxes.map((b) => b.name),
      byName: (n: string) => {
        const b = a.boxes.find((x) => x.name === n);
        return b ? boxObj(b) : { name: () => { throw notFound(); } };
      },
      push: (mb: Out) => {
        calls.push("push");
        if (opts.pushFails === "silent") return;
        if (opts.pushFails !== "throw") a.boxes.push({ name: mb._new.name, account: a, msgs: [] });
        if (opts.pushFails) throw new Error("Can't make class mailbox. (-10000)");
      },
    };
    return {
      _acct: a,
      name: () => a.name,
      id: () => a.id,
      enabled: () => a.enabled,
      accountType: () => a.type,
      mailboxes: new Proxy(mailboxes, { get: (t, k) => (typeof k === "string" && /^\d+$/.test(k) ? boxObj(a.boxes[Number(k)]) : t[k as string]) }),
    };
  };
  const unified = (name: string) => ({ mailboxes: () => (denied(), accts.filter((a) => a.enabled).map((a) => boxObj(a.boxes.find((b) => b.name === name)!))) });
  const mail = {
    running: () => opts.running ?? true,
    checkForNewMail: () => calls.push("check"),
    accounts: callable(() => accts.map(acctObj), {
      name: () => (denied(), accts.map((a) => a.name)),
      byName: (n: string) => {
        const a = accts.find((x) => x.name === n);
        return a ? acctObj(a) : { name: () => { throw notFound(); }, enabled: () => { throw notFound(); } };
      },
    }),
    inbox: unified("INBOX"),
    junkMailbox: unified("Junk"),
    move: (msg: Out, p: Out) => {
      calls.push("move");
      if (opts.moveFails) throw new Error("Can't move. (-10000)");
      moveMsg(msg._m, p.to._box);
    },
    Mailbox: (props: Out) => ({ _new: props }),
  };
  return { mail, accts, calls };
}

// ---------- Keeping the state between osascript calls ----------

export function dumpState(state: { accts: Acct[]; nextId: number }): string {
  return JSON.stringify({
    nextId: state.nextId,
    accounts: state.accts.map((a) => ({ ...a, boxes: a.boxes.map((b) => ({ name: b.name, msgs: b.msgs.map(({ box: _box, ...m }) => ({ ...m, date: m.date.toISOString() })) })) })),
  });
}

export function loadState(json: string): { accts: Acct[]; nextId: number } {
  const data = JSON.parse(json);
  const accts: Acct[] = data.accounts.map((a: Out) => {
    const acct = { ...a, boxes: [] } as unknown as Acct;
    acct.boxes = a.boxes.map((b: Out) => {
      const box: Box = { name: b.name, account: acct, msgs: [] };
      box.msgs = b.msgs.map((m: Out) => ({ ...m, date: new Date(m.date), box }));
      return box;
    });
    return acct;
  });
  return { accts, nextId: data.nextId };
}


