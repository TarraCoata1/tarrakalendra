import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  CalendarClock,
  LogOut,
  Sparkles,
  Trash2,
  X,
  Check,
  Loader2,
  CalendarOff,
  RefreshCw,
} from "lucide-react";
import {
  getMeetings,
  updateMeetingStatus,
  deleteMeeting,
  parseSchedulingText,
  createDirectMeeting,
  isOwner,
  syncMeetingToGoogle,
} from "@/lib/calendar.functions";
import { supabase } from "@/integrations/supabase/client";
import { formatDate, formatTime } from "@/lib/time";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: DashboardPage,
});

type Meeting = {
  id: string;
  title: string;
  start_time: string;
  end_time: string;
  status: "pending" | "confirmed" | "rejected" | "cancelled";
  source: "dashboard" | "telegram" | "public_booking";
  attendee_name: string | null;
  attendee_email: string | null;
  attendee_purpose: string | null;
  google_event_id: string | null;
};

function DashboardPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const fetchMeetings = useServerFn(getMeetings);
  const fetchIsOwner = useServerFn(isOwner);
  const runUpdate = useServerFn(updateMeetingStatus);
  const runDelete = useServerFn(deleteMeeting);
  const runParse = useServerFn(parseSchedulingText);
  const runCreate = useServerFn(createDirectMeeting);
  const runSync = useServerFn(syncMeetingToGoogle);

  const ownerQuery = useQuery({
    queryKey: ["is-owner"],
    queryFn: () => fetchIsOwner(),
  });

  const meetingsQuery = useQuery({
    queryKey: ["meetings"],
    queryFn: () => fetchMeetings() as Promise<Meeting[]>,
    enabled: !!ownerQuery.data?.isOwner,
  });

  const updateMut = useMutation({
    mutationFn: (v: { id: string; status: Meeting["status"] }) => runUpdate({ data: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["meetings"] }),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Update failed"),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => runDelete({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["meetings"] });
      toast.success("Deleted");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Delete failed"),
  });
  const syncMut = useMutation({
    mutationFn: (id: string) => runSync({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["meetings"] });
      toast.success("Synced to Google Calendar");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Sync failed"),
  });

  const [command, setCommand] = useState("");
  const [parsing, setParsing] = useState(false);
  const [preview, setPreview] = useState<{
    title: string;
    start_time: string;
    end_time: string;
  } | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  async function handleCommand(e: React.FormEvent) {
    e.preventDefault();
    if (!command.trim()) return;
    setParsing(true);
    try {
      const parsed = await runParse({ data: { text: command } });
      setPreview(parsed);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Parse failed");
    } finally {
      setParsing(false);
    }
  }

  async function confirmPreview() {
    if (!preview) return;
    try {
      await runCreate({ data: { ...preview, source: "dashboard" } });
      toast.success("Meeting created");
      setPreview(null);
      setCommand("");
      qc.invalidateQueries({ queryKey: ["meetings"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Create failed");
    }
  }

  async function signOut() {
    await qc.cancelQueries();
    qc.clear();
    await supabase.auth.signOut();
    nav({ to: "/auth", replace: true });
  }

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const meetings = meetingsQuery.data ?? [];
  const pending = meetings.filter((m) => m.status === "pending");
  const confirmed = meetings.filter((m) => m.status === "confirmed");
  const history = meetings.filter((m) => m.status === "rejected" || m.status === "cancelled");

  function handleDragEnd(ev: DragEndEvent) {
    setActiveId(null);
    if (!ev.over) return;
    const id = String(ev.active.id);
    const target = String(ev.over.id) as Meeting["status"];
    const current = meetings.find((m) => m.id === id);
    if (!current || current.status === target) return;
    updateMut.mutate({ id, status: target });
  }

  if (ownerQuery.isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }
  if (!ownerQuery.data?.isOwner) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="glass rounded-2xl p-8 max-w-md text-center">
          <h1 className="text-xl font-semibold">Access restricted</h1>
          <p className="text-sm text-muted-foreground mt-2">
            This workspace already has an owner. Sign out and use the owner's account.
          </p>
          <button
            onClick={signOut}
            className="mt-4 h-10 px-4 rounded-lg bg-primary text-primary-foreground"
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  const active = activeId ? meetings.find((m) => m.id === activeId) : null;

  return (
    <div className="min-h-screen">
      <header className="border-b border-border/50 backdrop-blur-lg sticky top-0 z-40 bg-background/80">
        <div className="max-w-[1600px] mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CalendarClock className="w-7 h-7 text-primary" />
            <span className="text-lg font-bold tracking-tight">Kalendra</span>
          </div>
          <nav className="flex items-center gap-2">
            <a href="/settings" className="text-sm px-3 py-2 rounded-lg hover:bg-accent">
              Settings
            </a>
            <a
              href="/book"
              target="_blank"
              className="text-sm px-3 py-2 rounded-lg hover:bg-accent"
            >
              Booking page
            </a>
            <button
              onClick={signOut}
              className="text-sm px-3 py-2 rounded-lg hover:bg-accent flex items-center gap-2"
            >
              <LogOut className="w-4 h-4" /> Sign out
            </button>
          </nav>
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto px-6 py-8">
        <form onSubmit={handleCommand} className="glass rounded-2xl p-4 mb-8">
          <label className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground mb-2">
            <Sparkles className="w-4 h-4 text-primary" /> AI Command
          </label>
          <div className="flex gap-3">
            <textarea
              dir="rtl"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              rows={2}
              placeholder="מה קובעים?"
              className="flex-1 bg-input rounded-lg px-4 py-3 border border-border focus:outline-none focus:ring-2 focus:ring-primary resize-none text-lg"
            />
            <button
              disabled={parsing || !command.trim()}
              className="px-6 rounded-lg bg-primary text-primary-foreground font-medium glow disabled:opacity-50 hover:glow-lg"
            >
              {parsing ? <Loader2 className="w-4 h-4 animate-spin" /> : "Parse"}
            </button>
          </div>
        </form>

        <DndContext
          sensors={sensors}
          onDragStart={(e) => setActiveId(String(e.active.id))}
          onDragEnd={handleDragEnd}
        >
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <Column id="pending" title="Pending" count={pending.length} pulse>
              {pending.map((m) => (
                <MeetingCard
                  key={m.id}
                  m={m}
                  onApprove={() => updateMut.mutate({ id: m.id, status: "confirmed" })}
                  onReject={() => updateMut.mutate({ id: m.id, status: "rejected" })}
                  onDelete={() => deleteMut.mutate(m.id)}
                />
              ))}
              {pending.length === 0 && <EmptyState label="No pending requests" />}
            </Column>
            <Column id="confirmed" title="Confirmed" count={confirmed.length}>
              {confirmed.map((m) => (
                <MeetingCard
                  key={m.id}
                  m={m}
                  onCancel={() => updateMut.mutate({ id: m.id, status: "cancelled" })}
                  onDelete={() => deleteMut.mutate(m.id)}
                  onSync={!m.google_event_id ? () => syncMut.mutate(m.id) : undefined}
                  syncing={syncMut.isPending && syncMut.variables === m.id}
                />
              ))}
              {confirmed.length === 0 && <EmptyState label="No confirmed meetings" />}
            </Column>
            <Column id="cancelled" title="History" count={history.length}>
              {history.map((m) => (
                <MeetingCard key={m.id} m={m} onDelete={() => deleteMut.mutate(m.id)} />
              ))}
              {history.length === 0 && <EmptyState label="No history yet" />}
            </Column>
          </div>
          <DragOverlay>{active ? <MeetingCard m={active} dragging /> : null}</DragOverlay>
        </DndContext>
      </main>

      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
          <div className="glass rounded-2xl p-6 max-w-md w-full">
            <h3 className="text-lg font-semibold mb-1">Confirm meeting</h3>
            <p className="text-xs text-muted-foreground mb-4">
              Review parsed details before saving to Google Calendar.
            </p>
            <div className="space-y-3 mb-4">
              <Field label="Title">
                <input
                  value={preview.title}
                  onChange={(e) => setPreview({ ...preview, title: e.target.value })}
                  className="w-full h-10 bg-input rounded-lg px-3 border border-border"
                />
              </Field>
              <Field label="When">
                <div className="text-sm">
                  {formatDate(preview.start_time)} · {formatTime(preview.start_time)} →{" "}
                  {formatTime(preview.end_time)}
                </div>
              </Field>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setPreview(null)}
                className="h-10 px-4 rounded-lg border border-border"
              >
                Cancel
              </button>
              <button
                onClick={confirmPreview}
                className="h-10 px-4 rounded-lg bg-primary text-primary-foreground glow"
              >
                Create meeting
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Column({
  id,
  title,
  count,
  pulse,
  children,
}: {
  id: string;
  title: string;
  count: number;
  pulse?: boolean;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={`rounded-2xl border border-border/60 p-4 min-h-[500px] bg-card/40 ${isOver ? "ring-2 ring-primary" : ""} ${pulse ? "pulse-glow" : ""}`}
    >
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold text-sm uppercase tracking-wider text-muted-foreground">
          {title}
        </h2>
        <span className="text-xs bg-accent px-2 py-1 rounded-md">{count}</span>
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function MeetingCard({
  m,
  onApprove,
  onReject,
  onCancel,
  onDelete,
  onSync,
  syncing,
  dragging,
}: {
  m: Meeting;
  onApprove?: () => void;
  onReject?: () => void;
  onCancel?: () => void;
  onDelete?: () => void;
  onSync?: () => void;
  syncing?: boolean;
  dragging?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: m.id });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;
  const sourceBadge = { dashboard: "Dashboard", telegram: "Telegram", public_booking: "Website" }[
    m.source
  ];
  const notSynced = m.status === "confirmed" && !m.google_event_id;
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className={`glass rounded-xl p-4 cursor-grab active:cursor-grabbing ${isDragging || dragging ? "opacity-50" : ""} hover:ring-1 hover:ring-primary/40 transition-all`}
    >
      <div className="flex items-start justify-between mb-2">
        <h3 className="font-semibold text-sm leading-tight">{m.title}</h3>
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-secondary/50 border border-primary/30 text-primary-foreground">
          {sourceBadge}
        </span>
      </div>
      <div className="text-xs text-muted-foreground space-y-0.5">
        <div>{formatDate(m.start_time)}</div>
        <div>
          {formatTime(m.start_time)} → {formatTime(m.end_time)}
        </div>
        {m.attendee_name && (
          <div className="pt-1 text-foreground">
            {m.attendee_name}
            {m.attendee_email && ` · ${m.attendee_email}`}
          </div>
        )}
        {m.attendee_purpose && <div className="italic">{m.attendee_purpose}</div>}
      </div>
      {notSynced && (
        <div className="flex items-center gap-1 text-[10px] text-amber-400 mt-2">
          <CalendarOff className="w-3 h-3" /> Not synced to Google Calendar
        </div>
      )}
      <div className="flex gap-2 mt-3">
        {onApprove && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onApprove();
            }}
            className="flex-1 h-8 text-xs rounded-md bg-primary/90 text-primary-foreground flex items-center justify-center gap-1 hover:bg-primary"
          >
            <Check className="w-3 h-3" /> Approve
          </button>
        )}
        {onReject && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onReject();
            }}
            className="flex-1 h-8 text-xs rounded-md border border-border hover:bg-destructive/20 flex items-center justify-center gap-1"
          >
            <X className="w-3 h-3" /> Reject
          </button>
        )}
        {onCancel && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onCancel();
            }}
            className="flex-1 h-8 text-xs rounded-md border border-border hover:bg-destructive/20"
          >
            Cancel
          </button>
        )}
        {onSync && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onSync();
            }}
            disabled={syncing}
            title="Retry Google Calendar sync"
            className="h-8 w-8 rounded-md border border-amber-400/40 text-amber-400 hover:bg-amber-400/10 flex items-center justify-center disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${syncing ? "animate-spin" : ""}`} />
          </button>
        )}
        {onDelete && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="h-8 w-8 rounded-md border border-border hover:bg-destructive/20 flex items-center justify-center"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return <div className="text-xs text-muted-foreground italic text-center py-8">{label}</div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs uppercase tracking-wider text-muted-foreground">{label}</label>
      <div className="mt-1">{children}</div>
    </div>
  );
}
