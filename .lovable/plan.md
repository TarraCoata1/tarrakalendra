# AI-Powered Kanban Calendar Management System

A dark-themed calendar app with three surfaces: authenticated Kanban dashboard, settings, and public booking page. Backed by Lovable Cloud (Postgres + auth + server functions), Lovable AI Gateway for Hebrew NL parsing, Google Calendar OAuth sync, and a Telegram webhook for natural-language scheduling.

## Stack decisions

- **Backend**: Lovable Cloud (enables Postgres + auth + secrets). All server logic via TanStack `createServerFn` and public server routes under `src/routes/api/public/*` for the Telegram webhook and OAuth callback.
- **AI**: Lovable AI Gateway (`LOVABLE_API_KEY`, auto-provisioned) — no user-supplied `LLM_API_KEY` needed. Model: `google/gemini-2.5-flash` with JSON response format.
- **Secrets needed from user**: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TELEGRAM_BOT_TOKEN`. `TELEGRAM_WEBHOOK_SECRET` auto-generated. No custom setup wizard — Lovable's secret prompts handle missing keys natively (cleaner than a locked splash screen and standard practice on this platform).
- **Auth**: Lovable Cloud email/password. Single-owner app — first signup becomes owner; only owner sees dashboard/settings. `/book` is public.
- **Timezone**: UTC in DB; render `Asia/Jerusalem` client-side via `Intl.DateTimeFormat` (no extra deps).
- **DnD**: `@dnd-kit/core` for Kanban drag-and-drop.
- **Cron**: pg_cron job every 15 min to auto-cancel pending bookings older than 48h.

## Design system

Dark theme tokens in `src/styles.css`:
- `--background: #0B0B0E`, `--card: #17141C`, `--primary: #8B5CF6`, `--secondary: #4C1D95`, `--foreground: #F5F5F5`, `--muted-foreground: #9C99A6`
- Primary glow utility class with `box-shadow: 0 0 15px rgba(139,92,246,0.3)`
- Glassmorphism card variant (backdrop-blur + translucent surface)
- Inter font via `<link>` in `__root.tsx`

## Database (migration)

```
meetings(id, title, start_time, end_time, status, source, attendee_name,
         attendee_email, attendee_purpose, google_event_id, created_at)
settings(id=1 singleton, working_hours jsonb, timezone, booking_page_title,
         booking_page_description, logo_url, google_connected,
         google_account_email, google_access_token, google_refresh_token,
         google_token_expiry)
user_roles(user_id, role) with app_role enum ('owner') + has_role() SECURITY DEFINER
```

RLS: `meetings` and `settings` — SELECT/INSERT/UPDATE/DELETE only for `has_role(auth.uid(),'owner')`. Public booking writes go through a server function using service role after Zod validation (never exposed to `anon`). Grants: `authenticated` on meetings/settings; `service_role` full.

Seed: single settings row inserted in migration.

## Server functions (`src/lib/*.functions.ts`)

- `parseSchedulingText({ text })` — calls Lovable AI Gateway (`ai.gateway.lovable.dev/v1/chat/completions`) with the Hebrew system prompt + current Asia/Jerusalem time; returns `{title, start_time, end_time}` (UTC ISO).
- `getAvailability({ from, to })` — public (no auth). Reads settings working hours, queries Google `freebusy` if connected (after `refreshGoogleTokenIfNeeded`), reads local pending+confirmed meetings, returns 60-min slots.
- `createPendingBooking({ start, end, name, email, purpose, title })` — public; Zod-validated; inserts `status='pending'`, `source='public_booking'`.
- `createDirectMeeting({ title, start, end })` — owner-only; inserts `confirmed`, pushes to Google Calendar, saves `google_event_id`.
- `approveBooking`, `rejectBooking`, `deleteMeeting`, `updateMeetingStatus` — owner-only with Google sync.
- `getMeetings`, `getSettings`, `updateSettings`, `updateWorkingHours` — owner-only.
- `googleDisconnect` — clears tokens.
- Helpers in `google.server.ts`: `refreshGoogleTokenIfNeeded`, `googleFetch(path, init)` wrapper.

## Server routes (`src/routes/api/public/*`)

- `oauth/google/start.ts` — owner-only (verify session), returns 302 to Google auth URL with `access_type=offline&prompt=consent&scope=calendar`, CSRF state in cookie.
- `oauth/google/callback.ts` — exchanges code, writes tokens to settings singleton, redirects to `/settings`.
- `telegram/webhook.ts` — verifies `X-Telegram-Bot-Api-Secret-Token`, extracts message text, calls parse + createDirect, replies in Hebrew via Telegram `sendMessage`. Only responds to owner's chat_id (stored in settings after first message, or via `/start` command).

Post-setup: agent runs `setWebhook` via curl once `TELEGRAM_BOT_TOKEN` is provided, using the `project--<id>-dev.lovable.app` stable URL.

## Frontend routes

- `src/routes/__root.tsx` — dark theme shell, Inter font, meta.
- `src/routes/index.tsx` — redirects `/dashboard` if signed in, else `/auth`.
- `src/routes/auth.tsx` — email/password login+signup, centered logo, glass card.
- `src/routes/_authenticated/route.tsx` — session gate (managed by Lovable Supabase integration).
- `src/routes/_authenticated/dashboard.tsx` — header (logo + user chip), Hebrew command box "מה קובעים?" with loading overlay + confirm toast, 3-column Kanban (Pending / Confirmed / History) using `@dnd-kit`. Cards show title, Asia/Jerusalem time, date, source badge, attendee metadata. DnD across columns triggers approve/reject; buttons for reschedule (modal with date/time picker) and cancel.
- `src/routes/_authenticated/settings.tsx` — Google connection hub (Connect/Disconnect), weekly working-hours grid (Sun–Sat, per-day active toggle + start/end inputs, matching Israeli week 0=Sun), branding (title/description/logo upload via Lovable Cloud storage), Telegram section (shows webhook status; button re-registers webhook), iframe embed code block with copy button.
- `src/routes/book.tsx` — public, no auth middleware. Fetches settings for branding, calls `getAvailability` for next 14 days, renders day-grouped slot grid. Selecting a slot opens inline form (name/email/purpose Zod-validated), submits `createPendingBooking`, shows success state.

## Cron

Migration adds `pg_cron` extension + job every 15 minutes: `UPDATE meetings SET status='cancelled' WHERE status='pending' AND created_at < NOW() - INTERVAL '48 hours'`.

## Build order

1. Enable Lovable Cloud.
2. Request secrets: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TELEGRAM_BOT_TOKEN`; auto-generate `TELEGRAM_WEBHOOK_SECRET`.
3. Migration: enums, tables, RLS/grants, seed, pg_cron job.
4. Design tokens + font.
5. Google helpers + server fns.
6. Auth route + `_authenticated` gate.
7. Dashboard Kanban.
8. Settings page + OAuth routes.
9. Public `/book` page.
10. Telegram webhook route + `setWebhook` call.
11. Smoke test each surface.

## Open questions before I build

1. **Setup wizard vs. native secret prompts** — Lovable's built-in `add_secret` opens a secure form for the owner. Building a custom "locked splash screen" duplicates that and stores keys in the DB instead of the secret vault (less secure). I'll use the native flow unless you insist on the custom UI.
2. **Owner identity** — first user to sign up becomes the sole owner (auto-grant `owner` role via trigger). Confirm this vs. hardcoding an email.
3. **Logo upload** — store in Lovable Cloud Storage bucket `branding` (public read), or accept a URL string only?

Reply and I'll proceed; if no reply, I'll go with the defaults above (native secrets, first-signup-is-owner, Cloud Storage bucket).