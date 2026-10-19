import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/db";

const TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

/** Serves rendered materials and screenshots from data/applications/<job-id>/. */
export async function GET(_req: Request, { params }: { params: Promise<{ jobId: string; name: string }> }) {
  const { jobId, name } = await params;
  if (!/^\d+$/.test(jobId) || !/^[\w.-]+$/.test(name)) return new Response("not found", { status: 404 });
  const file = path.join(DATA_DIR, "applications", jobId, name);
  const type = TYPES[path.extname(name).toLowerCase()];
  if (!type || !fs.existsSync(file)) return new Response("not found", { status: 404 });
  return new Response(fs.readFileSync(file), {
    headers: { "content-type": type, "content-disposition": `inline; filename="${name}"`, "cache-control": "no-store" },
  });
}
