import { HttpError } from "./store.js";

const ALLOWED_ORIGINS = new Set([
  "https://sunthanawit.github.io",
  "http://127.0.0.1:8765",
  "http://localhost:8765",
]);

export function cors(request) {
  const origin = request.headers.get("origin");
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://sunthanawit.github.io",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

export function json(request, body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors(request), ...headers },
  });
}

export function preflight(request) {
  return new Response(null, { status: 204, headers: cors(request) });
}

export async function readBody(request) {
  const text = await request.text();
  if (text.length > 4000) throw new HttpError(413, "ข้อมูลยาวเกินไป");
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw new HttpError(400, "รูปแบบข้อมูลไม่ถูกต้อง");
  }
}

export function handle(fn) {
  return async (request) => {
    try {
      return await fn(request);
    } catch (err) {
      if (err instanceof HttpError) return json(request, { error: err.message }, err.status);
      console.error(err);
      return json(request, { error: "เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่" }, 500);
    }
  };
}
