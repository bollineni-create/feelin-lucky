import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { ApiError, agentRoute } from "@/lib/agent-auth";
import { getApplication, logEvent } from "@/lib/logic";
import { applicationDir } from "@/lib/render";

const MAX_BYTES = 15 * 1024 * 1024;

/**
 * Confirmation-page screenshot after a submit. Accepts either
 *   multipart/form-data: application_id, file (PNG/JPEG), confirmation_text?
 *   application/json:    { application_id, png_base64?, confirmation_text? }
 * When no image can be captured, confirmation_text alone is still recorded.
 */
export const POST = agentRoute(async (req) => {
  let appId: number;
  let bytes: Buffer | null = null;
  let ext = "png";
  let text: string | null = null;

  const ctype = req.headers.get("content-type") ?? "";
  if (ctype.includes("multipart/form-data")) {
    const form = await req.formData();
    appId = Number(form.get("application_id"));
    text = (form.get("confirmation_text") as string | null) ?? null;
    const file = form.get("file");
    if (file && typeof file !== "string") {
      bytes = Buffer.from(await file.arrayBuffer());
      if (file.type === "image/jpeg") ext = "jpg";
    }
  } else {
    const body = (await req.json().catch(() => null)) as { application_id?: number; png_base64?: string; confirmation_text?: string } | null;
    if (!body) throw new ApiError(400, "body must be JSON or multipart");
    appId = Number(body.application_id);
    text = body.confirmation_text ?? null;
    if (body.png_base64) bytes = Buffer.from(body.png_base64.replace(/^data:image\/\w+;base64,/, ""), "base64");
  }

  if (!Number.isInteger(appId) || appId <= 0) throw new ApiError(400, "application_id is required");
  const app = getApplication(appId);
  if (!app) throw new ApiError(404, "application not found");
  if (!bytes && !text) throw new ApiError(400, "send a file/png_base64 or confirmation_text");
  if (bytes && bytes.length > MAX_BYTES) throw new ApiError(413, "screenshot too large");

  const patch: { confirmationScreenshot?: string; confirmationText?: string } = {};
  if (bytes) {
    const file = path.join(applicationDir(app.jobId), `confirmation-${Date.now()}.${ext}`);
    fs.writeFileSync(file, bytes);
    patch.confirmationScreenshot = file;
  }
  if (text) patch.confirmationText = text;
  db.update(schema.applications).set(patch).where(eq(schema.applications.id, appId)).run();
  logEvent({ applicationId: appId, type: "portal_update", title: "Submission confirmed", detail: text ?? "Confirmation screenshot saved" });
  return { saved: patch };
});
