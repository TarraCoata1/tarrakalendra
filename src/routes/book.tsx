import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { CalendarClock, Loader2, Check } from "lucide-react";
import { getAvailability, createPendingBooking, getPublicBranding } from "@/lib/calendar.functions";
import { formatDate, formatTime } from "@/lib/time";

export const Route = createFileRoute("/book")({
  ssr: false,
  component: BookPage,
});

function BookPage() {
  const fetchAvail = useServerFn(getAvailability);
  const fetchBranding = useServerFn(getPublicBranding);
  const submit = useServerFn(createPendingBooking);

  const branding = useQuery({ queryKey: ["branding"], queryFn: () => fetchBranding() });

  const range = useMemo(() => {
    const now = new Date();
    const from = new Date(Math.max(now.getTime(), Date.now()));
    const to = new Date(now.getTime() + 14 * 24 * 3600 * 1000);
    return { fromISO: from.toISOString(), toISO: to.toISOString() };
  }, []);

  const avail = useQuery({
    queryKey: ["availability", range],
    queryFn: () => fetchAvail({ data: range }) as Promise<{ slots: Array<{ start: string; end: string }> }>,
  });

  const [selected, setSelected] = useState<{ start: string; end: string } | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [purpose, setPurpose] = useState("");
  const [success, setSuccess] = useState(false);

  const bookMut = useMutation({
    mutationFn: () => submit({ data: {
      start_time: selected!.start, end_time: selected!.end,
      attendee_name: name, attendee_email: email, attendee_purpose: purpose,
    } }),
    onSuccess: () => setSuccess(true),
  });

  const grouped = useMemo(() => {
    const map = new Map<string, Array<{ start: string; end: string }>>();
    for (const s of avail.data?.slots ?? []) {
      const key = formatDate(s.start);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    return Array.from(map.entries());
  }, [avail.data]);

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="glass rounded-2xl p-10 max-w-md text-center">
          <div className="w-16 h-16 rounded-full bg-primary/20 flex items-center justify-center mx-auto mb-4 glow">
            <Check className="w-8 h-8 text-primary" />
          </div>
          <h1 className="text-2xl font-semibold">Reservation received</h1>
          <p className="text-sm text-muted-foreground mt-2">
            Your booking is a confirmation-pending hold. You'll be notified once it's approved.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <div className="max-w-3xl mx-auto px-6 py-12">
        <header className="text-center mb-10">
          {branding.data?.logo_url ? (
            <img src={branding.data.logo_url} alt="Logo" className="mx-auto mb-6 max-h-16" />
          ) : (
            <div className="flex justify-center items-center gap-2 mb-4">
              <CalendarClock className="w-8 h-8 text-primary" />
            </div>
          )}
          <h1 className="text-3xl font-bold">{branding.data?.booking_page_title ?? "Book a Session"}</h1>
          <p className="text-muted-foreground mt-2">{branding.data?.booking_page_description ?? ""}</p>
        </header>

        {avail.isLoading && <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>}

        {!selected && !avail.isLoading && (
          <div className="space-y-6">
            {grouped.length === 0 && <p className="text-center text-sm text-muted-foreground">No available slots in the next two weeks.</p>}
            {grouped.map(([day, slots]) => (
              <div key={day} className="glass rounded-2xl p-4">
                <h3 className="font-semibold mb-3 text-sm uppercase tracking-wider text-muted-foreground">{day}</h3>
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
                  {slots.map(s => (
                    <button key={s.start} onClick={() => setSelected(s)}
                      className="h-10 rounded-lg border border-border hover:border-primary hover:bg-primary/10 text-sm transition-all">
                      {formatTime(s.start)}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {selected && (
          <div className="glass rounded-2xl p-6 mt-4">
            <div className="mb-4">
              <button onClick={() => setSelected(null)} className="text-xs text-muted-foreground hover:text-foreground">← Pick a different time</button>
              <h3 className="font-semibold mt-2">{formatDate(selected.start)} · {formatTime(selected.start)} → {formatTime(selected.end)}</h3>
            </div>
            <form onSubmit={(e) => { e.preventDefault(); bookMut.mutate(); }} className="space-y-3">
              <input required maxLength={100} placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)}
                className="w-full h-11 bg-input rounded-lg px-3 border border-border" />
              <input required type="email" maxLength={255} placeholder="Email address" value={email} onChange={(e) => setEmail(e.target.value)}
                className="w-full h-11 bg-input rounded-lg px-3 border border-border" />
              <textarea required maxLength={1000} rows={3} placeholder="What's this meeting about?" value={purpose} onChange={(e) => setPurpose(e.target.value)}
                className="w-full bg-input rounded-lg px-3 py-2 border border-border resize-none" />
              {bookMut.isError && <div className="text-xs text-destructive">{(bookMut.error as Error).message}</div>}
              <button disabled={bookMut.isPending} className="w-full h-12 rounded-lg bg-primary text-primary-foreground font-medium glow hover:glow-lg disabled:opacity-50">
                {bookMut.isPending ? "Submitting…" : "Request booking"}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
