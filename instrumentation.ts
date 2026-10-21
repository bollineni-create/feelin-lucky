// Runs once when the app server starts: starts the 15-minute Apple Mail check (it does nothing until email
// tracking is turned on on the Mail page, and nothing off a Mac).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startMailTimer } = await import("./lib/mail");
    startMailTimer();
  }
}
