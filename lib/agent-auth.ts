import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";

/** Returns a 401 response unless the request carries `Authorization: Bearer $AGENT_TOKEN`. */
export function checkAgentToken(req: Request): NextResponse | null {
  const expected = process.env.AGENT_TOKEN;
  if (!expected) return NextResponse.json({ error: "AGENT_TOKEN is not configured on the server" }, { status: 503 });
  const header = req.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Ctx = { params: Promise<Record<string, string>> };

/** Wraps an /api/agent/* handler with token auth and uniform error responses. */
export function agentRoute(handler: (req: Request, params: Record<string, string>) => Promise<unknown>) {
  return async (req: Request, ctx: Ctx) => {
    const denied = checkAgentToken(req);
    if (denied) return denied;
    try {
      const result = await handler(req, ctx?.params ? await ctx.params : {});
      return result instanceof Response ? result : NextResponse.json(result);
    } catch (err) {
      if (err instanceof ApiError) return NextResponse.json({ error: err.message }, { status: err.status });
      if (err instanceof ZodError) return NextResponse.json({ error: "invalid body", issues: err.issues }, { status: 400 });
      console.error(err);
      return NextResponse.json({ error: err instanceof Error ? err.message : "server error" }, { status: 500 });
    }
  };
}

export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw new ApiError(400, "body must be JSON");
  }
  return schema.parse(json);
}

export function intParam(v: string | undefined, name = "id"): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new ApiError(400, `invalid ${name}`);
  return n;
}
