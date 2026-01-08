import { forbidden } from "../lib/respond";
import type { SessionPayload } from "./session";

export function requireCsrf(req: Request, session: SessionPayload) {
  const token = req.headers.get("x-csrf-token");
  if (!token || token !== session.csrf) {
    return forbidden("Missing or invalid CSRF token");
  }
  return null;
}
