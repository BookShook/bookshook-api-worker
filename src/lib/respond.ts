import { z } from "zod";

type RespondJsonOptions = {
  status?: number;
  cacheControl?: string;
};

/**
 * Returns a JSON response with proper headers.
 * Optionally validates payload against schema (development aid).
 */
export function respondJson<T extends z.ZodTypeAny>(
  _schema: T,
  payload: z.infer<T>,
  options: RespondJsonOptions = {}
): Response {
  const { status = 200, cacheControl } = options;

  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
  };

  if (cacheControl) {
    headers["cache-control"] = cacheControl;
  } else {
    headers["cache-control"] = "no-store";
    headers["pragma"] = "no-cache";
    headers["expires"] = "0";
  }

  return new Response(JSON.stringify(payload), { status, headers });
}

// Simple JSON helpers for community/admin/author routes
export function json(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function badRequest(message: string, details?: unknown) {
  return json({ error: message, details }, { status: 400 });
}

export function unauthorized(message = "Unauthorized") {
  return json({ error: message }, { status: 401 });
}

export function forbidden(message = "Forbidden") {
  return json({ error: message }, { status: 403 });
}

export function notFound(message = "Not Found") {
  return json({ error: message }, { status: 404 });
}

export function serverError(message = "Server Error", details?: unknown) {
  return json({ error: message, details }, { status: 500 });
}
