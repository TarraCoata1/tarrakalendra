// Server-only Google Calendar helpers.
import { createClient } from "@supabase/supabase-js";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_API = "https://www.googleapis.com/calendar/v3";

export function serviceClient() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface SettingsRow {
  google_connected: boolean;
  google_account_email: string | null;
  google_access_token: string | null;
  google_refresh_token: string | null;
  google_token_expiry: string | null;
}

type RefreshResult =
  | { ok: true; access_token: string; expires_in: number }
  | { ok: false; status: number; body: string };

async function refreshAccessToken(refreshToken: string): Promise<RefreshResult> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error(
      "[google] Missing GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET secrets — cannot refresh token",
    );
    return { ok: false, status: 0, body: "missing_client_credentials" };
  }
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    console.error(`[google] Token refresh failed (${resp.status}): ${body}`);
    return { ok: false, status: resp.status, body };
  }
  const json = await resp.json();
  return { ok: true, access_token: json.access_token, expires_in: json.expires_in };
}

export async function getFreshAccessToken(): Promise<string | null> {
  const svc = serviceClient();
  const { data: s } = await svc.from("settings").select("*").eq("id", 1).single();
  if (!s) return null;

  if (!s.google_refresh_token) {
    // No refresh token on file at all — nothing to do. If the row is still
    // flagged as connected, correct it so Settings stops claiming a working
    // connection that doesn't actually exist.
    if (s.google_connected) {
      await svc.from("settings").update({ google_connected: false }).eq("id", 1);
    }
    return null;
  }
  if (!s.google_connected) return null;

  const expiresAt = s.google_token_expiry ? new Date(s.google_token_expiry as string).getTime() : 0;
  const fiveMinFromNow = Date.now() + 5 * 60 * 1000;
  if (s.google_access_token && expiresAt > fiveMinFromNow) {
    return s.google_access_token as string;
  }

  const refreshed = await refreshAccessToken(s.google_refresh_token as string);
  if (!refreshed.ok) {
    // A 400 from Google's token endpoint almost always means invalid_grant —
    // the refresh token was revoked or expired (e.g. the Google Cloud OAuth
    // consent screen is still in "Testing" publishing status, which caps
    // refresh tokens at 7 days; or the user revoked access from their
    // Google Account permissions page). Reflect that in settings instead of
    // failing the same way silently forever.
    if (refreshed.status === 400) {
      await svc.from("settings").update({ google_connected: false }).eq("id", 1);
    }
    return null;
  }

  const newExpiry = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
  await svc
    .from("settings")
    .update({
      google_access_token: refreshed.access_token,
      google_token_expiry: newExpiry,
    })
    .eq("id", 1);
  return refreshed.access_token;
}

export async function googleFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getFreshAccessToken();
  if (!token) throw new Error("Google Calendar not connected");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(`${GOOGLE_API}${path}`, { ...init, headers });
}

export async function createGoogleEvent(params: {
  title: string;
  startISO: string;
  endISO: string;
  description?: string;
  attendeeEmail?: string;
}): Promise<string | null> {
  try {
    const body: Record<string, unknown> = {
      summary: params.title,
      description: params.description ?? "",
      start: { dateTime: params.startISO, timeZone: "Asia/Jerusalem" },
      end: { dateTime: params.endISO, timeZone: "Asia/Jerusalem" },
    };
    if (params.attendeeEmail) body.attendees = [{ email: params.attendeeEmail }];
    const resp = await googleFetch("/calendars/primary/events", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      console.error(`[google] createGoogleEvent failed (${resp.status}): ${await resp.text()}`);
      return null;
    }
    const data = await resp.json();
    return data.id ?? null;
  } catch (err) {
    console.error("[google] createGoogleEvent threw:", err);
    return null;
  }
}

export async function deleteGoogleEvent(eventId: string): Promise<void> {
  try {
    const resp = await googleFetch(`/calendars/primary/events/${encodeURIComponent(eventId)}`, {
      method: "DELETE",
    });
    if (!resp.ok && resp.status !== 410) {
      // 410 Gone just means it was already removed from the calendar — fine to ignore.
      console.error(`[google] deleteGoogleEvent failed (${resp.status}): ${await resp.text()}`);
    }
  } catch (err) {
    console.error("[google] deleteGoogleEvent threw:", err);
  }
}

export async function googleFreeBusy(
  timeMin: string,
  timeMax: string,
): Promise<Array<{ start: string; end: string }>> {
  try {
    const resp = await googleFetch(`/freeBusy`, {
      method: "POST",
      body: JSON.stringify({
        timeMin,
        timeMax,
        timeZone: "Asia/Jerusalem",
        items: [{ id: "primary" }],
      }),
    });
    if (!resp.ok) {
      console.error(`[google] googleFreeBusy failed (${resp.status}): ${await resp.text()}`);
      return [];
    }
    const data = await resp.json();
    const busy = data?.calendars?.primary?.busy ?? [];
    return busy as Array<{ start: string; end: string }>;
  } catch (err) {
    console.error("[google] googleFreeBusy threw:", err);
    return [];
  }
}
