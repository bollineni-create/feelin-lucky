// Runs once when the app server starts: starts the 15-minute Apple Mail check (it does nothing until email
// tracking is turned on on the Mail page, and nothing off a Mac), and the two-minute apply handoff sync (reads
// what the apply agent reported back and rewrites the apply queue file).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startMailTimer } = await import("./lib/mail");
    startMailTimer();
    const { startHandoffTimer } = await import("./lib/handoff");
    startHandoffTimer();
  }
}
