import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireOwner } from "./owner-middleware";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { jerusalemDayOfWeek, jerusalemDateTimeToUTC, TIMEZONE } from "./time";

// --------------------------- Settings ---------------------------

export const getSettings = createServerFn({ method: "GET" })
  .middleware([requireOwner])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase.from("settings").select("*").eq("id", 1).single();
    if (error) throw new Error(error.message);
    return data;
  });

const workingHoursSchema = z.record(
  z.string(),
  z.array(z.object({ start: z.string(), end: z.string() })),
);

export const updateSettings = createServerFn({ method: "POST" })
  .middleware([requireOwner])
  .inputValidator((d: {
    working_hours?: Record<string, Array<{ start: string; end: string }>>;
    booking_page_title?: string;
    booking_page_description?: string;
    logo_url?: string | null;
  }) => {
    const schema = z.object({
      working_hours: workingHoursSchema.optional(),
      booking_page_title: z.string().max(200).optional(),
      booking_page_description: z.string().max(1000).optional(),
      logo_url: z.string().max(2000).nullable().optional(),
    });
    return schema.parse(d);
  })
  .handler(async ({ data, context }) => {
    const patch: {
      updated_at: string;
      working_hours?: Record<string, Array<{ start: string; end: string }>>;
      booking_page_title?: string;
      booking_page_description?: string;
      logo_url?: string | null;
    } = { updated_at: new Date().toISOString() };
    if (data.working_hours) patch.working_hours = data.working_hours;
    if (data.booking_page_title !== undefined) patch.booking_page_title = data.booking_page_title;
    if (data.booking_page_description !== undefined) patch.booking_page_description = data.booking_page_description;
    if (data.logo_url !== undefined) patch.logo_url = data.logo_url;
    const { error } = await context.supabase.from("settings").update(patch).eq("id", 1);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// --------------------------- Public settings (branding) ---------------------------

export const getPublicBranding = createServerFn({ method: "GET" }).handler(async () => {
  const { serviceClient } = await import("./google.server");
  const svc = serviceClient();
  const { data } = await svc
    .from("settings")
    .select("booking_page_title, booking_page_description, logo_url")
    .eq("id", 1)
    .single();
  return data ?? { booking_page_title: "Book a Session", booking_page_description: "", logo_url: null };
});

// --------------------------- Meetings ---------------------------

export const getMeetings = createServerFn({ method: "GET" })
  .middleware([requireOwner])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("meetings")
      .select("*")
      .order("start_time", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const updateMeetingStatus = createServerFn({ method: "POST" })
  .middleware([requireOwner])
  .inputValidator((d: { id: string; status: "pending" | "confirmed" | "rejected" | "cancelled" }) =>
    z.object({
      id: z.string().uuid(),
      status: z.enum(["pending", "confirmed", "rejected", "cancelled"]),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: meeting } = await context.supabase.from("meetings").select("*").eq("id", data.id).single();
    if (!meeting) throw new Error("Meeting not found");

    const { createGoogleEvent, deleteGoogleEvent } = await import("./google.server");

    // Approve -> create Google event
    if (data.status === "confirmed" && !meeting.google_event_id) {
      const eventId = await createGoogleEvent({
        title: meeting.title,
        startISO: meeting.start_time as string,
        endISO: meeting.end_time as string,
        description: meeting.attendee_purpose ?? "",
        attendeeEmail: meeting.attendee_email ?? undefined,
      });
      await context.supabase.from("meetings").update({
        status: "confirmed",
        google_event_id: eventId,
      }).eq("id", data.id);
      return { ok: true };
    }

    // Cancel/reject -> delete Google event
    if ((data.status === "cancelled" || data.status === "rejected") && meeting.google_event_id) {
      await deleteGoogleEvent(meeting.google_event_id as string);
      await context.supabase.from("meetings").update({
        status: data.status,
        google_event_id: null,
      }).eq("id", data.id);
      return { ok: true };
    }

    const { error } = await context.supabase.from("meetings").update({ status: data.status }).eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteMeeting = createServerFn({ method: "POST" })
  .middleware([requireOwner])
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: meeting } = await context.supabase.from("meetings").select("google_event_id").eq("id", data.id).single();
    if (meeting?.google_event_id) {
      const { deleteGoogleEvent } = await import("./google.server");
      await deleteGoogleEvent(meeting.google_event_id as string);
    }
    const { error } = await context.supabase.from("meetings").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const rescheduleMeeting = createServerFn({ method: "POST" })
  .middleware([requireOwner])
  .inputValidator((d: { id: string; start_time: string; end_time: string }) =>
    z.object({
      id: z.string().uuid(),
      start_time: z.string(),
      end_time: z.string(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: meeting } = await context.supabase.from("meetings").select("*").eq("id", data.id).single();
    if (!meeting) throw new Error("Meeting not found");

    const { deleteGoogleEvent, createGoogleEvent } = await import("./google.server");
    if (meeting.google_event_id) await deleteGoogleEvent(meeting.google_event_id as string);
    let newEventId: string | null = null;
    if (meeting.status === "confirmed") {
      newEventId = await createGoogleEvent({
        title: meeting.title,
        startISO: data.start_time,
        endISO: data.end_time,
        description: meeting.attendee_purpose ?? "",
        attendeeEmail: meeting.attendee_email ?? undefined,
      });
    }
    const { error } = await context.supabase.from("meetings").update({
      start_time: data.start_time,
      end_time: data.end_time,
      google_event_id: newEventId,
    }).eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// --------------------------- NL Parser (Hebrew) ---------------------------

export const parseSchedulingText = createServerFn({ method: "POST" })
  .middleware([requireOwner])
  .inputValidator((d: { text: string }) => z.object({ text: z.string().min(1).max(2000) }).parse(d))
  .handler(async ({ data }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("LOVABLE_API_KEY missing");

    const now = new Date();
    const jerusalemNow = new Intl.DateTimeFormat("sv-SE", {
      timeZone: TIMEZONE,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    }).format(now);

    const systemPrompt = `You are an absolute time-parsing engine for an Israeli calendar app.
Analyze the user's Hebrew text input and return EXACTLY a raw JSON object with keys: "title", "start_time" (ISO8601 string in UTC), and "end_time" (ISO8601 string in UTC).
Do not include markdown wrappers, thoughts, or extra characters.
Current Reference Time: ${jerusalemNow} in timezone Asia/Jerusalem.
Default meeting duration: 60 minutes.
Parse relative descriptions accurately (e.g., "יום חמישי ב-4 אחה"צ" means the next upcoming Thursday at 16:00 Asia/Jerusalem time, then convert to UTC).`;

    const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: data.text },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`AI parse failed: ${resp.status} ${t}`);
    }
    const body = await resp.json();
    const content = body?.choices?.[0]?.message?.content ?? "{}";
    let parsed: { title: string; start_time: string; end_time: string };
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error("AI returned non-JSON content");
    }
    return parsed;
  });

// --------------------------- Create direct meeting (owner) ---------------------------

export const createDirectMeeting = createServerFn({ method: "POST" })
  .middleware([requireOwner])
  .inputValidator((d: { title: string; start_time: string; end_time: string; source?: "dashboard" | "telegram" }) =>
    z.object({
      title: z.string().min(1).max(200),
      start_time: z.string(),
      end_time: z.string(),
      source: z.enum(["dashboard", "telegram"]).optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { createGoogleEvent } = await import("./google.server");
    const eventId = await createGoogleEvent({
      title: data.title,
      startISO: data.start_time,
      endISO: data.end_time,
    });
    const { data: row, error } = await context.supabase.from("meetings").insert({
      title: data.title,
      start_time: data.start_time,
      end_time: data.end_time,
      status: "confirmed",
      source: data.source ?? "dashboard",
      google_event_id: eventId,
    }).select("*").single();
    if (error) throw new Error(error.message);
    return row;
  });

// --------------------------- Availability (public) ---------------------------

export const getAvailability = createServerFn({ method: "POST" })
  .inputValidator((d: { fromISO: string; toISO: string }) =>
    z.object({ fromISO: z.string(), toISO: z.string() }).parse(d),
  )
  .handler(async ({ data }) => {
    const { serviceClient, googleFreeBusy } = await import("./google.server");
    const svc = serviceClient();
    const { data: settings } = await svc.from("settings").select("*").eq("id", 1).single();
    const workingHours = (settings?.working_hours ?? {}) as Record<string, Array<{ start: string; end: string }>>;
    const isConnected = !!settings?.google_connected;

    const from = new Date(data.fromISO);
    const to = new Date(data.toISO);
    if (to.getTime() - from.getTime() > 40 * 24 * 3600 * 1000) {
      throw new Error("Range too large");
    }

    // Local meetings that block slots
    const { data: meetings } = await svc
      .from("meetings")
      .select("start_time, end_time, status")
      .in("status", ["pending", "confirmed"])
      .gte("start_time", from.toISOString())
      .lte("start_time", to.toISOString());

    const busy: Array<{ start: number; end: number }> = (meetings ?? []).map((m) => ({
      start: new Date(m.start_time as string).getTime(),
      end: new Date(m.end_time as string).getTime(),
    }));

    if (isConnected) {
      const freeBusy = await googleFreeBusy(from.toISOString(), to.toISOString());
      for (const b of freeBusy) {
        busy.push({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() });
      }
    }

    const slots: Array<{ start: string; end: string }> = [];
    const oneDay = 24 * 3600 * 1000;
    for (let t = from.getTime(); t < to.getTime(); t += oneDay) {
      const dayDate = new Date(t);
      const dow = jerusalemDayOfWeek(dayDate);
      const windows = workingHours[String(dow)] ?? [];
      for (const w of windows) {
        const startUTC = jerusalemDateTimeToUTC(dayDate, w.start);
        const endUTC = jerusalemDateTimeToUTC(dayDate, w.end);
        for (let s = startUTC.getTime(); s + 3600 * 1000 <= endUTC.getTime(); s += 3600 * 1000) {
          const e = s + 3600 * 1000;
          if (s < Date.now()) continue;
          const clash = busy.some(b => s < b.end && e > b.start);
          if (!clash) {
            slots.push({ start: new Date(s).toISOString(), end: new Date(e).toISOString() });
          }
        }
      }
    }
    return { slots };
  });

// --------------------------- Public pending booking ---------------------------

export const createPendingBooking = createServerFn({ method: "POST" })
  .inputValidator((d: {
    start_time: string; end_time: string;
    attendee_name: string; attendee_email: string; attendee_purpose: string;
  }) =>
    z.object({
      start_time: z.string(),
      end_time: z.string(),
      attendee_name: z.string().trim().min(1).max(100),
      attendee_email: z.string().trim().email().max(255),
      attendee_purpose: z.string().trim().min(1).max(1000),
    }).parse(d),
  )
  .handler(async ({ data }) => {
    const { serviceClient } = await import("./google.server");
    const svc = serviceClient();
    const start = new Date(data.start_time).getTime();
    const end = new Date(data.end_time).getTime();
    if (isNaN(start) || isNaN(end) || end <= start || start < Date.now()) {
      throw new Error("Invalid time range");
    }
    // Re-check no clash with existing pending/confirmed
    const { data: clash } = await svc
      .from("meetings")
      .select("id")
      .in("status", ["pending", "confirmed"])
      .lt("start_time", new Date(end).toISOString())
      .gt("end_time", new Date(start).toISOString())
      .limit(1);
    if (clash && clash.length > 0) throw new Error("Slot no longer available");

    const { error } = await svc.from("meetings").insert({
      title: `Booking: ${data.attendee_name}`,
      start_time: new Date(start).toISOString(),
      end_time: new Date(end).toISOString(),
      status: "pending",
      source: "public_booking",
      attendee_name: data.attendee_name,
      attendee_email: data.attendee_email,
      attendee_purpose: data.attendee_purpose,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// --------------------------- Google disconnect ---------------------------

export const googleDisconnect = createServerFn({ method: "POST" })
  .middleware([requireOwner])
  .handler(async ({ context }) => {
    const { error } = await context.supabase.from("settings").update({
      google_connected: false,
      google_account_email: null,
      google_access_token: null,
      google_refresh_token: null,
      google_token_expiry: null,
    }).eq("id", 1);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// --------------------------- Check if user is owner ---------------------------

export const isOwner = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase.rpc("has_role", {
      _user_id: context.userId, _role: "owner",
    });
    return { isOwner: !!data };
  });
