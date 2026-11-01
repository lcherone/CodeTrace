import { randomBytes } from "node:crypto";
import { PROTOCOL_VERSION, type BrowserLaunchResponse, type EditorContextPayload, type EditorContextResponse, type EditorContextState } from "@trace/contracts";

const SESSION_COOKIE = "trace_browser_session";

export class BrowserSessionBroker {
  private readonly tickets = new Map<string, number>();
  private readonly sessions = new Map<string, number>();

  constructor(private readonly ticketLifetimeMs = 60_000, private readonly sessionLifetimeMs = 8 * 60 * 60 * 1_000) {}

  launch(origin: string, now = Date.now()): BrowserLaunchResponse {
    this.prune(now);
    const ticket = randomBytes(32).toString("base64url");
    const expires = now + this.ticketLifetimeMs;
    this.tickets.set(ticket, expires);
    return { protocolVersion: PROTOCOL_VERSION, url: `${origin}/?ticket=${encodeURIComponent(ticket)}`, expiresAt: new Date(expires).toISOString() };
  }

  exchange(ticket: string, now = Date.now()): { cookie: string; expiresAt: number } | undefined {
    this.prune(now);
    const expires = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!expires || expires <= now) return undefined;
    const session = randomBytes(32).toString("base64url");
    const sessionExpires = now + this.sessionLifetimeMs;
    this.sessions.set(session, sessionExpires);
    return { cookie: `${SESSION_COOKIE}=${session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(this.sessionLifetimeMs / 1_000)}`, expiresAt: sessionExpires };
  }

  authenticate(cookieHeader: string | undefined, now = Date.now()): boolean {
    this.prune(now);
    const cookies = new Map((cookieHeader ?? "").split(";").map((item) => item.trim().split(/=(.*)/s).slice(0, 2) as [string, string]));
    const session = cookies.get(SESSION_COOKIE);
    return Boolean(session && (this.sessions.get(session) ?? 0) > now);
  }

  private prune(now: number): void {
    for (const [ticket, expires] of this.tickets) if (expires <= now) this.tickets.delete(ticket);
    for (const [session, expires] of this.sessions) if (expires <= now) this.sessions.delete(session);
  }
}

interface Waiter { after: number; finish: (response: EditorContextResponse) => void; timer: ReturnType<typeof setTimeout> }

export class EditorContextHub {
  private version = 0;
  private context: EditorContextState | null = null;
  private readonly waiters = new Set<Waiter>();

  publish(clientId: string, payload: EditorContextPayload | null, generation?: number): EditorContextResponse {
    if (payload === null && this.context?.clientId && this.context.clientId !== clientId) return this.response();
    this.version++;
    this.context = payload === null ? null : { clientId, ...payload, generation: generation ?? 0, receivedAt: new Date().toISOString() };
    const response = this.response();
    for (const waiter of [...this.waiters]) if (response.version > waiter.after) waiter.finish(response);
    return response;
  }

  response(): EditorContextResponse { return { protocolVersion: PROTOCOL_VERSION, version: this.version, context: this.context }; }

  async poll(after: number, waitMs: number, signal?: AbortSignal): Promise<EditorContextResponse> {
    if (this.version > after || waitMs === 0) return this.response();
    signal?.throwIfAborted();
    return new Promise<EditorContextResponse>((resolve, reject) => {
      const finish = (response: EditorContextResponse) => { clearTimeout(waiter.timer); this.waiters.delete(waiter); signal?.removeEventListener("abort", abort); resolve(response); };
      const abort = () => { clearTimeout(waiter.timer); this.waiters.delete(waiter); reject(new DOMException("Editor context poll cancelled", "AbortError")); };
      const waiter: Waiter = { after, finish, timer: setTimeout(() => finish(this.response()), waitMs) };
      this.waiters.add(waiter);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}
