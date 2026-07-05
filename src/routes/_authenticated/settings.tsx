import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CalendarClock, ArrowLeft, Check, Copy, ExternalLink } from "lucide-react";
import { getSettings, updateSettings, googleDisconnect } from "@/lib/calendar.functions";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsPage,
});

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type WorkingHours = Record<string, Array<{ start: string; end: string }>>;

function SettingsPage() {
  const qc = useQueryClient();
  const fetchSettings = useServerFn(getSettings);
  const saveSettings = useServerFn(updateSettings);
  const disconnect = useServerFn(googleDisconnect);

  const q = useQuery({ queryKey: ["settings"], queryFn: () => fetchSettings() });

  const [wh, setWh] = useState<WorkingHours>({});
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [logo, setLogo] = useState("");

  useEffect(() => {
    if (q.data) {
      setWh((q.data.working_hours as WorkingHours) ?? {});
      setTitle(q.data.booking_page_title ?? "");
      setDesc(q.data.booking_page_description ?? "");
      setLogo(q.data.logo_url ?? "");
    }
  }, [q.data]);

  const saveMut = useMutation({
    mutationFn: () => saveSettings({ data: {
      working_hours: wh,
      booking_page_title: title,
      booking_page_description: desc,
      logo_url: logo || null,
    } }),
    onSuccess: () => { toast.success("Saved"); qc.invalidateQueries({ queryKey: ["settings"] }); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Save failed"),
  });

  const disconnectMut = useMutation({
    mutationFn: () => disconnect(),
    onSuccess: () => { toast.success("Google disconnected"); qc.invalidateQueries({ queryKey: ["settings"] }); },
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("google") === "connected") toast.success("Google Calendar connected");
    if (params.get("google_error")) toast.error("Google connection failed: " + params.get("google_error"));
  }, []);

  function toggleDay(dow: number, active: boolean) {
    setWh(prev => ({ ...prev, [String(dow)]: active ? [{ start: "09:00", end: "18:00" }] : [] }));
  }
  function setDayHours(dow: number, start: string, end: string) {
    setWh(prev => ({ ...prev, [String(dow)]: [{ start, end }] }));
  }

  const embedCode = typeof window !== "undefined"
    ? `<iframe src="${window.location.origin}/book" width="100%" height="720" style="border:none;border-radius:16px;"></iframe>`
    : "";

  return (
    <div className="min-h-screen">
      <header className="border-b border-border/50 backdrop-blur-lg sticky top-0 z-40 bg-background/80">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
          <a href="/dashboard" className="flex items-center gap-2 hover:text-primary">
            <ArrowLeft className="w-4 h-4" /> <span className="text-sm">Back to dashboard</span>
          </a>
          <div className="flex items-center gap-2">
            <CalendarClock className="w-6 h-6 text-primary" />
            <span className="font-bold">Settings</span>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-8">
        {/* Google Calendar */}
        <Section title="Google Calendar" desc="Sync confirmed meetings to your calendar and read your busy times.">
          {q.data?.google_connected ? (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center">
                  <Check className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <div className="font-medium text-sm">Connected</div>
                  <div className="text-xs text-muted-foreground">{q.data.google_account_email}</div>
                </div>
              </div>
              <button onClick={() => disconnectMut.mutate()} className="h-10 px-4 rounded-lg border border-border hover:bg-destructive/20 text-sm">
                Disconnect
              </button>
            </div>
          ) : (
            <a href="/api/public/oauth/google/start" className="inline-flex items-center gap-2 h-11 px-5 rounded-lg bg-primary text-primary-foreground glow hover:glow-lg font-medium">
              Connect Google Calendar <ExternalLink className="w-4 h-4" />
            </a>
          )}
        </Section>

        {/* Working hours */}
        <Section title="Working hours" desc="Israeli workweek layout (Sunday–Saturday).">
          <div className="space-y-2">
            {DAY_NAMES.map((name, dow) => {
              const day = wh[String(dow)] ?? [];
              const active = day.length > 0;
              const start = day[0]?.start ?? "09:00";
              const end = day[0]?.end ?? "18:00";
              return (
                <div key={dow} className="flex items-center gap-4 py-2 border-b border-border/40 last:border-0">
                  <div className="w-28 font-medium text-sm">{name}</div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={active} onChange={(e) => toggleDay(dow, e.target.checked)} className="w-4 h-4 accent-primary" />
                    <span className="text-xs text-muted-foreground">{active ? "Open" : "Closed"}</span>
                  </label>
                  {active && (
                    <div className="flex items-center gap-2 ml-auto">
                      <input type="time" value={start} onChange={(e) => setDayHours(dow, e.target.value, end)}
                        className="h-9 bg-input rounded-lg px-3 border border-border" />
                      <span className="text-muted-foreground">→</span>
                      <input type="time" value={end} onChange={(e) => setDayHours(dow, start, e.target.value)}
                        className="h-9 bg-input rounded-lg px-3 border border-border" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>

        {/* Branding */}
        <Section title="Booking page branding" desc="Customize the public /book page.">
          <div className="space-y-4">
            <Labeled label="Page title">
              <input value={title} onChange={(e) => setTitle(e.target.value)} className="w-full h-10 bg-input rounded-lg px-3 border border-border" />
            </Labeled>
            <Labeled label="Description">
              <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={3}
                className="w-full bg-input rounded-lg px-3 py-2 border border-border resize-none" />
            </Labeled>
            <Labeled label="Logo URL (optional)">
              <input value={logo} onChange={(e) => setLogo(e.target.value)} placeholder="https://…" className="w-full h-10 bg-input rounded-lg px-3 border border-border" />
            </Labeled>
          </div>
        </Section>

        <Section title="Telegram bot" desc="Send Hebrew scheduling messages to your bot and confirmed meetings land here automatically.">
          <div className="text-sm text-muted-foreground">
            {q.data?.telegram_chat_id
              ? <>Linked chat ID: <span className="text-foreground">{String(q.data.telegram_chat_id)}</span>. Send messages to your bot and they will parse into meetings.</>
              : <>Send <code className="bg-input px-1 rounded">/start</code> to your Telegram bot to link this workspace.</>
            }
          </div>
        </Section>

        <Section title="Website embed" desc="Copy this snippet to embed the booking page anywhere.">
          <div className="relative">
            <pre className="text-xs bg-input rounded-lg p-4 overflow-x-auto border border-border">{embedCode}</pre>
            <button
              onClick={() => { navigator.clipboard.writeText(embedCode); toast.success("Copied"); }}
              className="absolute top-2 right-2 h-8 px-3 rounded-md bg-primary/90 text-xs text-primary-foreground flex items-center gap-1"
            >
              <Copy className="w-3 h-3" /> Copy
            </button>
          </div>
        </Section>

        <div className="flex justify-end sticky bottom-4">
          <button
            onClick={() => saveMut.mutate()}
            disabled={saveMut.isPending}
            className="h-12 px-8 rounded-xl bg-primary text-primary-foreground font-medium glow hover:glow-lg disabled:opacity-50"
          >
            {saveMut.isPending ? "Saving…" : "Save changes"}
          </button>
        </div>
      </main>
    </div>
  );
}

function Section({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="glass rounded-2xl p-6">
      <div className="mb-4">
        <h2 className="font-semibold">{title}</h2>
        <p className="text-xs text-muted-foreground mt-1">{desc}</p>
      </div>
      {children}
    </div>
  );
}
function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs uppercase tracking-wider text-muted-foreground">{label}</label>
      <div className="mt-1">{children}</div>
    </div>
  );
}
