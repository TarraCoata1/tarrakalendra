import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { createHash, timingSafeEqual } from "crypto";

function deriveWebhookSecret(botToken: string): string {
  return createHash("sha256").update(`telegram-webhook:${botToken}`).digest("base64url");
}
function safeEqual(a: string, b: string): boolean {
  const A = Buffer.from(a),
    B = Buffer.from(b);
  return A.length === B.length && timingSafeEqual(A, B);
}

async function sendTelegramMessage(botToken: string, chatId: number, text: string) {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
    if (!resp.ok)
      console.error(`[telegram] sendMessage failed (${resp.status}): ${await resp.text()}`);
  } catch (err) {
    console.error("[telegram] sendMessage threw:", err);
  }
}

async function callAI(
  text: string,
  apiKey: string,
): Promise<{ title: string; start_time: string; end_time: string } | null> {
  const jerusalemNow = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
  const systemPrompt = `You are an absolute time-parsing engine for an Israeli calendar app.
Analyze the user's Hebrew text input and return EXACTLY a raw JSON object with keys: "title", "start_time" (ISO8601 string in UTC), and "end_time" (ISO8601 string in UTC).
Do not include markdown wrappers, thoughts, or extra characters.
Current Reference Time: ${jerusalemNow} in timezone Asia/Jerusalem.
Default meeting duration: 60 minutes.
Parse relative descriptions accurately.`;
  const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
      response_format: { type: "json_object" },
    }),
  });
  if (!resp.ok) {
    console.error(`[telegram] AI parse request failed (${resp.status}): ${await resp.text()}`);
    return null;
  }
  const body = await resp.json();
  try {
    return JSON.parse(body?.choices?.[0]?.message?.content ?? "{}");
  } catch (err) {
    console.error(
      "[telegram] AI returned non-JSON content:",
      body?.choices?.[0]?.message?.content,
      err,
    );
    return null;
  }
}

export const Route = createFileRoute("/api/public/telegram/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        const aiKey = process.env.LOVABLE_API_KEY;
        if (!botToken) return new Response("Bot not configured", { status: 500 });

        const expected = deriveWebhookSecret(botToken);
        const actual = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
        if (!safeEqual(actual, expected)) return new Response("Unauthorized", { status: 401 });

        const update = await request.json();
        const message = update.message ?? update.edited_message;
        const chatId: number | undefined = message?.chat?.id;
        const text: string | undefined = message?.text;
        if (!chatId || !text) return Response.json({ ok: true, ignored: true });

        const svc = createClient(
          process.env.SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!,
          { auth: { persistSession: false, autoRefreshToken: false } },
        );

        // Bind chat to owner if none yet
        const { data: settings } = await svc
          .from("settings")
          .select("telegram_chat_id, google_connected")
          .eq("id", 1)
          .single();
        if (!settings?.telegram_chat_id) {
          await svc.from("settings").update({ telegram_chat_id: chatId }).eq("id", 1);
        } else if (settings.telegram_chat_id !== chatId) {
          await sendTelegramMessage(botToken, chatId, "⚠️ צ׳אט זה אינו מקושר לחשבון הבעלים.");
          return Response.json({ ok: true });
        }

        if (text.trim().startsWith("/start")) {
          await sendTelegramMessage(
            botToken,
            chatId,
            '👋 היי! שלח לי טקסט חופשי בעברית כדי לקבוע פגישה. לדוגמה: <i>יום חמישי ב-4 אחה"צ פגישה עם דנה</i>',
          );
          return Response.json({ ok: true });
        }

        if (!aiKey) {
          await sendTelegramMessage(botToken, chatId, "❌ שירות ה-AI אינו זמין.");
          return Response.json({ ok: true });
        }

        const parsed = await callAI(text, aiKey);
        if (!parsed?.title || !parsed?.start_time || !parsed?.end_time) {
          await sendTelegramMessage(
            botToken,
            chatId,
            "😕 לא הצלחתי להבין את הפגישה. נסה שוב עם תאריך ושעה ברורים.",
          );
          return Response.json({ ok: true });
        }

        // Create Google event if connected — and remember *why not* when we can't,
        // instead of silently pretending it worked.
        let googleEventId: string | null = null;
        let googleStatus: "synced" | "not_connected" | "sync_failed" = "not_connected";
        if (settings?.google_connected) {
          try {
            const { createGoogleEvent } = await import("@/lib/google.server");
            googleEventId = await createGoogleEvent({
              title: parsed.title,
              startISO: parsed.start_time,
              endISO: parsed.end_time,
            });
            googleStatus = googleEventId ? "synced" : "sync_failed";
          } catch (err) {
            console.error("[telegram] Google event creation threw:", err);
            googleStatus = "sync_failed";
          }
        }

        await svc.from("meetings").insert({
          title: parsed.title,
          start_time: parsed.start_time,
          end_time: parsed.end_time,
          status: "confirmed",
          source: "telegram",
          google_event_id: googleEventId,
        });

        const timeStr = new Intl.DateTimeFormat("he-IL", {
          timeZone: "Asia/Jerusalem",
          weekday: "long",
          day: "2-digit",
          month: "long",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(new Date(parsed.start_time));

        const statusLine = {
          synced: "📅 סונכרן ל-Google Calendar",
          not_connected: "⚠️ לא סונכרן ל-Google Calendar — היומן לא מחובר (התחבר בהגדרות)",
          sync_failed:
            "⚠️ הפגישה נשמרה, אבל הסנכרון ל-Google Calendar נכשל (בדוק את החיבור בהגדרות)",
        }[googleStatus];

        await sendTelegramMessage(
          botToken,
          chatId,
          `✅ נקבע בהצלחה!\n<b>${parsed.title}</b>\n📅 ${timeStr}\n${statusLine}`,
        );

        return Response.json({ ok: true });
      },
    },
  },
});
