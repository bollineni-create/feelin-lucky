// The bridge between Lodestar and Apple Mail, in JavaScript for Automation. lib/mail.ts runs it:
//   osascript -l JavaScript scripts/mail/mail.js '{"cmd": "status"}'
// and reads one line of JSON back. Commands:
//   status  {running}: whether Mail is open. Sends Mail nothing, so it never asks for permission or opens Mail.
//   list    {since, accounts, include_junk, fetch, domains, terms, known, max_bodies, body_chars}: messages received
//           since `since` in each account's Inbox (and Junk). Reads sender and subject for all of them, and the body
//           only of those whose sender domain is in `domains` or whose sender or subject has one of `terms` (the rest
//           are never read), skipping Message-IDs in `known`. Oldest first, at most `max_bodies`. `fetch` has Mail
//           check its servers first.
//   file    {mailbox, actions: [{message_id, mail_id, account_id, account, where, move, rescue, flag}]}: finds each
//           message where the listing (or an earlier filing) left it, sets or clears its flag, and moves it into
//           `mailbox` inside its own account (making that mailbox there if needed), or with `rescue` from Junk back
//           to the account's inbox. A message is reported `gone` only when Mail says it isn't there (-1728).
// It never sends, replies to or deletes anything. Failures come back as {ok: false, error, number}; -1743 means
// macOS hasn't allowed this to control Mail. scripts/mail/mail.test.ts runs it against a stand-in Mail.
//
// Learned from others scripting Mail on real Macs: a Message-ID search ("whose message id is …") isn't indexed and
// can freeze Mail for many seconds on a big inbox, so messages are found again by Mail's own id in a known mailbox;
// moving a message reached through the unified Inbox or Junk can crash Mail, so everything goes through each
// account's own mailboxes; and a scripted move on Gmail often adds the label but leaves the message in the inbox,
// so each move is checked rather than trusted.

function run(argv) {
  var input;
  try {
    input = JSON.parse(argv[0] || "{}");
  } catch (e) {
    return JSON.stringify({ ok: false, error: "The bridge got input it couldn't read: " + e.message });
  }
  try {
    return JSON.stringify(handle(Application("Mail"), input, shell));
  } catch (e) {
    return JSON.stringify({ ok: false, error: String((e && e.message) || e), number: errNum(e) });
  }
}

function handle(Mail, input, sh) {
  if (input.cmd === "status") return { ok: true, running: Mail.running() };
  if (input.cmd === "list") return list(Mail, input);
  if (input.cmd === "file") return file(Mail, input, sh);
  return { ok: false, error: "Unknown command: " + input.cmd };
}

// ---------- helpers ----------

function errNum(e) {
  if (e && typeof e.errorNumber === "number") return e.errorNumber;
  var m = /\((-?\d+)\)\s*$/.exec(String((e && e.message) || e));
  return m ? Number(m[1]) : null;
}

// Mail gives the Message-ID with or without its angle brackets; header-less messages give nothing.
function bare(id) {
  var s = String(id == null ? "" : id).trim().replace(/^<+/, "").replace(/>+$/, "");
  return s === "missing value" ? "" : s;
}

function wait(seconds) {
  if (typeof delay === "function") delay(seconds);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function domainOf(sender) {
  var m = String(sender || "").match(/@([^\s>]+)\s*>?\s*$/);
  return m ? m[1].toLowerCase().replace(/\.$/, "") : "";
}

function looksRelevant(input) {
  var domains = (input.domains || []).map(function (d) { return d.toLowerCase(); });
  var terms = (input.terms || []).filter(function (t) { return t; }).map(escapeRe);
  var termRe = terms.length ? new RegExp("(?:^|[^a-z0-9])(?:" + terms.join("|") + ")(?:[^a-z0-9]|$)", "i") : null;
  return function (sender, subject) {
    var d = domainOf(sender);
    for (var i = 0; i < domains.length; i++) if (d === domains[i] || d.slice(-(domains[i].length + 1)) === "." + domains[i]) return true;
    return termRe ? termRe.test(String(sender || "") + " " + String(subject || "")) : false;
  };
}

// A mailbox in an account by its (leaf) name, any case, or null. An account's `mailboxes` is a flat list.
function findBox(acct, name) {
  try {
    var mb = acct.mailboxes.byName(name);
    mb.name();
    return mb;
  } catch (e) {}
  try {
    var names = acct.mailboxes.name();
    for (var i = 0; i < names.length; i++) {
      if (String(names[i]).toLowerCase() === String(name).toLowerCase()) return acct.mailboxes[i];
    }
  } catch (e) {}
  return null;
}

var BOX_NAMES = { inbox: ["INBOX", "Inbox"], junk: ["Junk", "Spam", "Junk Email", "Junk E-mail", "Bulk Mail", "[Gmail]/Spam"] };

// Each account's own Inbox (or Junk): the unified mailbox's per-account mailboxes, else by name.
function accountBoxes(Mail, where) {
  var out = [];
  try {
    var unified = where === "junk" ? Mail.junkMailbox : Mail.inbox;
    unified.mailboxes().forEach(function (mb) {
      try {
        var acct = mb.account();
        out.push({ account: acct.name(), accountId: acct.id(), box: mb });
      } catch (e) {}
    });
  } catch (e) {}
  if (out.length) return out;
  Mail.accounts().forEach(function (acct) {
    try {
      if (acct.enabled() === false) return;
      var names = BOX_NAMES[where];
      for (var i = 0; i < names.length; i++) {
        var mb = findBox(acct, names[i]);
        if (mb) return out.push({ account: acct.name(), accountId: acct.id(), box: mb });
      }
    } catch (e) {}
  });
  return out;
}

function boxFor(Mail, where, accountId, account) {
  var all = accountBoxes(Mail, where);
  for (var i = 0; i < all.length; i++) if (accountId ? all[i].accountId === accountId : all[i].account === account) return all[i].box;
  return null;
}

// The account a message was listed in, by Mail's id for it (two accounts can share a name), else by name.
function accountFor(Mail, accountId, account) {
  if (accountId) {
    var hits = Mail.accounts.whose({ id: accountId })();
    return hits.length ? hits[0] : null;
  }
  try {
    var acct = Mail.accounts.byName(account);
    acct.name();
    return acct;
  } catch (e) {
    if (errNum(e) === -1728) return null;
    throw e;
  }
}

// A message by Mail's own id in a mailbox, checked against its Message-ID. `scan` also searches by Message-ID,
// which is only reasonable in a small mailbox (Junk, Lodestar).
// Only Mail saying "can't get object" (-1728) means the message isn't there; anything else (Mail busy, quitting, a
// permission withdrawn) is passed on, so the caller retries rather than giving up on the message.
function findMessage(box, mailId, messageId, scan) {
  var want = bare(messageId);
  if (mailId != null) {
    try {
      var m = box.messages.byId(Number(mailId));
      if (bare(m.messageId()) === want) return m;
    } catch (e) {
      if (errNum(e) !== -1728) throw e;
    }
  }
  if (!scan) return null;
  var hits = box.messages.whose({ _or: [{ messageId: want }, { messageId: "<" + want + ">" }] })();
  return hits.length ? hits[0] : null;
}

// ---------- list ----------

// Header fields of the messages a whose-specifier selects. Each read of a filtered list makes Mail run the filter
// again, so the ids are read once; then a small mailbox gives each field in one Apple Event (read twice if the
// list changed meanwhile), and a big one is read message by message by id, which is quick.
var FIELDS = ["messageId", "sender", "subject", "dateReceived", "deletedStatus"];
function headers(box, spec) {
  var ids = spec.id();
  if (!ids.length) return { id: [], messageId: [], sender: [], subject: [], dateReceived: [], deletedStatus: [] };
  var total = ids.length;
  try {
    total = box.messages.length;
  } catch (e) {}
  if (total <= Math.max(2000, ids.length * 300)) {
    for (var attempt = 0; attempt < 2; attempt++) {
      var h = { id: attempt ? spec.id() : ids };
      FIELDS.forEach(function (f) { h[f] = spec[f](); });
      var n = h.id.length;
      // The same messages, in the same order, before and after: nothing arrived or left in between.
      if (FIELDS.every(function (f) { return h[f].length === n; }) && String(spec.id()) === String(h.id)) return h;
    }
  }
  var out = { id: [] };
  FIELDS.forEach(function (f) { out[f] = []; });
  ids.forEach(function (id) {
    try {
      var m = box.messages.byId(id);
      var row = FIELDS.map(function (f) { return m[f](); });
      out.id.push(id);
      FIELDS.forEach(function (f, i) { out[f].push(row[i]); });
    } catch (e) {}
  });
  return out;
}

function list(Mail, input) {
  if (!Mail.running()) return { ok: true, running: false };
  // Mail fetches on its own schedule; only a check someone asked for nudges it (it contacts the servers).
  if (input.fetch) {
    try {
      Mail.checkForNewMail();
      // It returns at once; give the download a few seconds to finish before reading.
      for (var w = 0; w < 10; w++) {
        wait(1);
        if (Mail.backgroundActivityCount() === 0) break;
      }
    } catch (e) {}
  }
  var accounts = Mail.accounts.name();
  var since = new Date(input.since);
  var wanted = input.accounts || [];
  var known = {};
  (input.known || []).forEach(function (k) { known[bare(k)] = true; });
  var relevant = looksRelevant(input);
  var sources = accountBoxes(Mail, "inbox").map(function (s) { return { account: s.account, accountId: s.accountId, box: s.box, where: "inbox" }; });
  if (input.include_junk) sources = sources.concat(accountBoxes(Mail, "junk").map(function (s) { return { account: s.account, accountId: s.accountId, box: s.box, where: "junk" }; }));
  sources = sources.filter(function (s) { return !wanted.length || wanted.indexOf(s.account) >= 0; });

  var scanned = 0;
  var newest = null;
  var picks = [];
  var problems = [];
  sources.forEach(function (src) {
    var h;
    try {
      h = headers(src.box, src.box.messages.whose({ dateReceived: { _greaterThan: since } }));
    } catch (e) {
      if (errNum(e) === -1743) throw e;
      problems.push(src.account + " " + src.where + ": " + String((e && e.message) || e));
      return;
    }
    scanned += h.id.length;
    for (var i = 0; i < h.id.length; i++) {
      var date = h.dateReceived[i];
      if (!newest || date > newest) newest = date;
      var mid = bare(h.messageId[i]);
      // A copy an IMAP move left behind, marked deleted until the server expunges it.
      if (h.deletedStatus[i]) continue;
      if (!mid || known[mid] || !relevant(h.sender[i], h.subject[i])) continue;
      known[mid] = true;
      picks.push({ src: src, id: h.id[i], messageId: mid, sender: h.sender[i], subject: h.subject[i], date: date });
    }
  });
  // Nothing could be read at all: say so rather than report an empty mailbox.
  if (sources.length && problems.length === sources.length) throw new Error("Mail didn't list any mailbox: " + problems[0]);

  picks.sort(function (a, b) { return a.date - b.date; });
  var max = input.max_bodies || 80;
  var chars = input.body_chars || 6000;
  var take = picks.slice(0, max);
  var truncated = picks.length > max;
  // When some are left for next time, the next check has to start no later than the last one read.
  if (truncated && take.length) newest = take[take.length - 1].date;

  var messages = [];
  var unread = 0;
  take.forEach(function (p) {
    var body = "";
    var msg = null;
    try {
      msg = findMessage(p.src.box, p.id, p.messageId, false);
      // Attachments and inline images show up as U+FFFC.
      if (msg) body = String(msg.content() || "").replace(/\uFFFC/g, "").replace(/\r\n?/g, "\n");
    } catch (e) {
      if (errNum(e) === -1743) throw e;
      msg = null;
    }
    // Moved meanwhile, or a body Mail couldn't give yet (still downloading): left out, so the next check reads it.
    if (!msg || !body.trim()) {
      unread++;
      return;
    }
    messages.push({
      message_id: p.messageId,
      mail_id: p.id,
      account: p.src.account,
      account_id: p.src.accountId,
      where: p.src.where,
      sender: p.sender,
      subject: p.subject,
      received_at: new Date(p.date).toISOString(),
      body: body.slice(0, chars),
    });
  });

  return {
    ok: true,
    running: true,
    accounts: accounts,
    scanned: scanned,
    newest: newest ? newest.toISOString() : null,
    truncated: truncated,
    unread: unread,
    problems: problems,
    messages: messages,
  };
}

// ---------- file ----------

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Runs an AppleScript in a separate osascript, with its values as arguments so nothing needs escaping inside it.
function shell(lines, args) {
  var app = Application.currentApplication();
  app.includeStandardAdditions = true;
  var cmd = "/usr/bin/osascript";
  lines.forEach(function (l) { cmd += " -e " + shellQuote(l); });
  (args || []).forEach(function (a) { cmd += " " + shellQuote(a); });
  app.doShellScript(cmd);
}

// The `name` mailbox inside the account, made there if it isn't yet: on the account, not "On My Mac", so it
// syncs to the server and the phone. Mail can raise an error and still make the mailbox, and an IMAP server can
// take a few seconds to show it, so after each way of making it, it's looked for again.
function ensureMailbox(Mail, acct, name, sh, cache) {
  var acctName = acct.name();
  if (cache[acctName]) {
    if (cache[acctName].error) throw new Error(cache[acctName].error);
    return cache[acctName].box;
  }
  var box = findBox(acct, name);
  if (box) return (cache[acctName] = { box: box }).box;
  var ways = [
    function () { acct.mailboxes.push(Mail.Mailbox({ name: name })); },
    function () {
      sh(
        ["on run argv", 'tell application "Mail"', "set acct to first account whose id is (item 1 of argv)", "make new mailbox at end of mailboxes of acct with properties {name:(item 2 of argv)}", "end tell", "end run"],
        [acct.id(), name],
      );
    },
  ];
  var lastError = null;
  for (var w = 0; w < ways.length; w++) {
    try {
      ways[w]();
    } catch (e) {
      lastError = e;
    }
    for (var t = 0; t < 20; t++) {
      box = findBox(acct, name);
      if (box) return (cache[acctName] = { box: box }).box;
      wait(0.5);
    }
  }
  var msg = "Couldn't create the \"" + name + "\" mailbox in " + acctName + (lastError ? " (" + String(lastError.message || lastError) + ")" : "") +
    ". Create it in Mail (Mailbox > New Mailbox, Location: " + acctName + ") and Lodestar will use it.";
  cache[acctName] = { error: msg };
  throw new Error(msg);
}

// Whether the message has left where it was: its reference is dead (-1728), or it's an IMAP copy marked deleted
// until the server expunges it.
function leftSource(msg) {
  try {
    return msg.deletedStatus() === true;
  } catch (e) {
    return errNum(e) === -1728;
  }
}

// The moved copy in the destination, given a moment to show up.
function landedIn(box, messageId) {
  for (var i = 0; i < 4; i++) {
    var m = findMessage(box, null, messageId, true);
    if (m) return m;
    wait(0.5);
  }
  return null;
}

// Moves the message and reports what happened: {moved_to, mail_id, still_in_inbox}. Gmail usually keeps a
// scripted move in the inbox and adds the label, which counts as filed. Mail can raise an error and still move, so
// the destination is looked at before anything else is tried.
function moveTo(Mail, msg, box, name, messageId) {
  var failure = null;
  try {
    Mail.move(msg, { to: box });
  } catch (e) {
    failure = e;
  }
  var landed = landedIn(box, messageId);
  if (!landed && failure) {
    // Reached by id through a mailbox that isn't its own container (Gmail files inbox mail under All Mail), Mail
    // can't move it: look it up through its own mailbox and try again, then the other way of moving.
    try {
      msg = msg.mailbox().messages.byId(msg.id());
      Mail.move(msg, { to: box });
    } catch (e2) {
      try {
        msg.mailbox = box;
      } catch (e3) {}
    }
    landed = landedIn(box, messageId);
  }
  var left = leftSource(msg);
  if (landed) {
    var r = { moved_to: name, mail_id: null };
    try {
      r.mail_id = landed.id();
    } catch (e) {}
    if (!left) r.still_in_inbox = true;
    return { result: r, message: landed };
  }
  if (left) return { result: { moved_to: name, mail_id: null }, message: null };
  throw failure || new Error("Mail didn't move it.");
}

function file(Mail, input, sh) {
  if (!Mail.running()) return { ok: false, error: "Mail isn't running.", number: -600 };
  var name = input.mailbox || "Lodestar";
  var cache = {};
  var results = (input.actions || []).map(function (a) {
    var r = { message_id: a.message_id };
    try {
      var acct = accountFor(Mail, a.account_id, a.account);
      if (!acct) {
        r.gone = true;
        return r;
      }
      if (acct.enabled() === false) {
        r.error = a.account + " is turned off in Mail.";
        return r;
      }
      var where = a.where || "inbox";
      var box = where === "inbox" || where === "junk" ? boxFor(Mail, where, a.account_id, a.account) : findBox(acct, where);
      // A big inbox is only looked up by id; Junk and Lodestar are small enough to search.
      var msg = box ? findMessage(box, a.mail_id, a.message_id, where !== "inbox") : null;
      if (!msg) {
        r.gone = true;
        return r;
      }
      if (a.flag === true || a.flag === false) {
        msg.flaggedStatus = a.flag;
        r.flagged = a.flag;
      }
      var dest = null;
      var destName = null;
      if (a.move) {
        var type = "";
        try {
          type = String(acct.accountType());
        } catch (e) {}
        // Exchange shows up as "unknown"; a mailbox a script makes there may never reach the server.
        if (type === "unknown") {
          r.skipped = "Mail can't reliably make a mailbox in this account (Exchange) from a script, so its job emails stay where they are.";
        } else {
          dest = ensureMailbox(Mail, acct, name, sh, cache);
          destName = name;
        }
      }
      // Something to answer shouldn't sit in Junk, where it can be deleted unread: back to the account's inbox.
      if (!dest && a.rescue && where === "junk") {
        dest = boxFor(Mail, "inbox", a.account_id, a.account);
        destName = "inbox";
      }
      if (dest) {
        if (where === "junk") {
          try {
            msg.junkMailStatus = false;
          } catch (e) {}
        }
        var moved = moveTo(Mail, msg, dest, destName, a.message_id);
        if (destName === "inbox") {
          r.rescued = true;
          r.mail_id = moved.result.mail_id;
        } else {
          Object.keys(moved.result).forEach(function (k) { r[k] = moved.result[k]; });
        }
        if (a.flag === true && moved.message) {
          try {
            moved.message.flaggedStatus = true;
          } catch (e) {}
        }
      }
    } catch (e) {
      if (errNum(e) === -1743) throw e;
      r.error = String((e && e.message) || e);
    }
    return r;
  });
  return { ok: true, results: results };
}
