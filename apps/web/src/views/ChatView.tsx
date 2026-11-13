import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { ConversationDto, MessageDto, TicketDto, Track, TrackSwitchDto } from "@orch/contracts";
import { api, post, put, subscribe } from "../api";
import { useApp } from "../App";
import { MessageView } from "../components/MessageView";
import { TicketTree } from "../components/TicketTree";

export function ChatView() {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const { me, setToggleTarget } = useApp();
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [tickets, setTickets] = useState<TicketDto[]>([]);

  // The side panel shows conversations grouped by ticket, and the general chats.
  const loadConversations = useCallback(async () => {
    const [list, grouped] = await Promise.all([api<ConversationDto[]>("/api/conversations"), api<TicketDto[]>("/api/tickets")]);
    setConversations(list);
    setTickets(grouped);
  }, []);

  useEffect(() => {
    void loadConversations();
    let timer: ReturnType<typeof setTimeout> | undefined;
    return subscribe((n) => {
      if (n.t === "msg" || n.t === "pending" || n.t === "run") {
        clearTimeout(timer);
        timer = setTimeout(() => void loadConversations(), 400);
      }
    });
  }, [loadConversations]);

  // Without an id, open the last conversation or start a new one.
  useEffect(() => {
    if (conversationId || !me) return;
    const target = me.lastConversationId && conversations.some((c) => c.id === me.lastConversationId) ? me.lastConversationId : conversations[0]?.id;
    if (target) navigate(`/chat/${target}`, { replace: true });
  }, [conversationId, me, conversations, navigate]);

  useEffect(() => {
    if (conversationId) void put("/api/preferences", { lastConversationId: conversationId });
  }, [conversationId]);

  const current = conversations.find((c) => c.id === conversationId);
  useEffect(() => {
    setToggleTarget(current?.focusedRunId ? `/ops/runs/${current.focusedRunId}` : "/ops/runs");
    return () => setToggleTarget(null);
  }, [current?.focusedRunId, setToggleTarget]);

  const newConversation = async () => {
    const c = await post<ConversationDto>("/api/conversations", {});
    await loadConversations();
    navigate(`/chat/${c.id}`);
  };

  return (
    <div className="chat-layout">
      <aside className="sidebar">
        <button className="primary block" onClick={() => void newConversation()}>
          + New conversation
        </button>
        <TicketTree
          tickets={tickets}
          chats={conversations.filter((c) => c.kind === "general")}
          currentId={conversationId}
          onOpen={(id) => navigate(`/chat/${id}`)}
        />
      </aside>
      {conversationId ? (
        <Conversation key={conversationId} id={conversationId} kind={current?.kind ?? "general"} />
      ) : (
        <EmptyState onStart={() => void newConversation()} />
      )}
    </div>
  );
}

function EmptyState({ onStart }: { onStart: () => void }) {
  const { me } = useApp();
  return (
    <section className="empty-state">
      <h2>Start a conversation</h2>
      <p className="muted">
        Ask the assistant to work on an issue (for example <em>"work on {me?.repos[0] ?? "owner/repo"}#12"</em>), or label an issue{" "}
        <code>{me?.triggerLabel ?? "ai-ready"}</code> on GitHub and it will appear here automatically.
      </p>
      <button className="primary" onClick={onStart}>
        New conversation
      </button>
    </section>
  );
}

interface DesignState {
  runId: string;
  state: "active" | "suspending" | "suspended" | "closed";
  turnRunning: boolean;
  /** Started afresh from the current plan; the next message starts the new session. */
  fresh: boolean;
}

const TRACK_TEXT: Record<Track, string> = {
  fast: "Fast track: the change is built, reviewed by an agent and opened as a pull request, with no stops before it.",
  guided: "Guided track: you agree the plan with the architect agent, and check each change before its pull request opens.",
};

/**
 * Switching the track of a run (FR-A3), shown in its conversation while it is allowed. The orchestrator checks
 * again when the request arrives: the work may have moved on meanwhile.
 */
function TrackSwitch({ runId, track }: { runId: string; track: TrackSwitchDto }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  const to = track.to;
  if (!to || state === "sent") return null;
  const label = to === "guided" ? "Switch to the guided track" : "Switch to the fast track";
  const submit = async () => {
    setState("busy");
    setError(null);
    try {
      await post(`/api/runs/${runId}/track`, { track: to, reason: reason.trim() || undefined });
      setState("sent");
    } catch (e) {
      setError((e as Error).message);
      setState("idle");
    }
  };
  return (
    <div className="track-switch" role="group" aria-label="Track">
      {!open ? (
        <>
          <span className="muted small">{TRACK_TEXT[track.current ?? (to === "guided" ? "fast" : "guided")]}</span>
          <button className="ghost small" onClick={() => setOpen(true)}>
            {label}
          </button>
        </>
      ) : (
        <>
          <span className="small">
            {to === "guided"
              ? "The change being built is set aside, nothing is pushed, and a design session with the architect agent starts from the analysis."
              : "The design session ends; the current plan, if there is one, becomes a single change built with no stops before the pull request."}
          </span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why? (optional, recorded on the ticket)" maxLength={500} aria-label="Why" />
          <button className="primary small" disabled={state === "busy"} onClick={() => void submit()}>
            {label}
          </button>
          <button className="ghost small" onClick={() => setOpen(false)}>
            Keep the {track.current} track
          </button>
        </>
      )}
      {error && <span className="error small">{error}</span>}
    </div>
  );
}

/** R-14 fallback: a long design session starts again from the current plan, without the conversation before it. */
function FreshSession({ runId }: { runId: string }) {
  const [state, setState] = useState<"idle" | "confirm" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  if (state === "sent") return <span className="muted small"> A fresh session starts with your next message.</span>;
  if (state === "idle") {
    return (
      <button className="link small" onClick={() => setState("confirm")} title="For a long session: the architect keeps the analysis and the current plan, not the conversation">
        Start afresh from the current plan
      </button>
    );
  }
  return (
    <span className="small">
      {" "}
      The architect will keep the analysis and the current plan, but not this conversation.{" "}
      <button
        className="link small"
        onClick={() =>
          void post(`/api/runs/${runId}/fresh-session`, {}).then(
            () => setState("sent"),
            (e: Error) => setError(e.message),
          )
        }
      >
        Start afresh
      </button>{" "}
      <button className="link small" onClick={() => setState("idle")}>
        Keep the session
      </button>
      {error && <span className="error small"> {error}</span>}
    </span>
  );
}

function Conversation({ id, kind }: { id: string; kind: ConversationDto["kind"] }) {
  const [messages, setMessages] = useState<MessageDto[]>([]);
  // Set while the run's design session is open: messages here go to the architect agent (AD-38).
  const [design, setDesign] = useState<DesignState | null>(null);
  const [track, setTrack] = useState<TrackSwitchDto | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [streaming, setStreaming] = useState("");
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const maxVersion = useRef(0);

  const merge = useCallback((incoming: MessageDto[]) => {
    setMessages((prev) => {
      const byId = new Map(prev.map((m) => [m.id, m]));
      for (const m of incoming) byId.set(m.id, m);
      return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.version - b.version);
    });
    for (const m of incoming) maxVersion.current = Math.max(maxVersion.current, m.version);
  }, []);

  const loadAfter = useCallback(async () => {
    const data = await api<{ conversation: ConversationDto; messages: MessageDto[]; busy: boolean; design: DesignState | null; track: TrackSwitchDto | null }>(
      `/api/conversations/${id}?after=${maxVersion.current}`,
    );
    merge(data.messages);
    setDesign(data.design);
    setTrack(data.track);
    setRunId(data.conversation.focusedRunId ?? null);
    return data;
  }, [id, merge]);

  useEffect(() => {
    maxVersion.current = 0;
    void loadAfter().then((d) => setTyping(d.busy));
    return subscribe((n) => {
      if (n.t === "msg" && n.c === id && n.v > maxVersion.current) void loadAfter();
      // The design session opening, being saved or resumed, or closing changes who answers here.
      if (n.t === "run" && kind === "run") void loadAfter();
      if (n.t === "delta" && n.c === id) setStreaming((s) => s + n.text);
      if (n.t === "typing" && n.c === id) {
        setTyping(n.on);
        if (!n.on) setStreaming("");
      }
    });
  }, [id, kind, loadAfter]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, streaming, typing]);

  const send = async (text: string) => {
    if (!text.trim()) return;
    setError(null);
    setDraft("");
    try {
      await post(`/api/conversations/${id}/messages`, { text });
    } catch (e) {
      setError((e as Error).message);
      setDraft(text);
    }
  };

  const submitForm = async (title: string | undefined, values: Record<string, string>) => {
    setError(null);
    try {
      await post(`/api/conversations/${id}/form`, { title, values });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // Starting afresh needs a plan to start from.
  const hasPlan = messages.some((m) => m.components.some((c) => c.type === "plan"));

  const timeline = useMemo(
    () => messages.map((m) => <MessageView key={m.id} message={m} onSubmitForm={submitForm} />),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages],
  );

  return (
    <section className="conversation">
      {design && (
        <div className={`design-strip ${design.state}`} role="status">
          <strong>Design session with the architect agent.</strong>{" "}
          {design.fresh && !design.turnRunning
            ? "A fresh session starts from the current plan with your next message: the architect will not see the conversation before this point."
            : design.state === "active"
            ? "Your messages here go to the architect. Ask about the code, set constraints, ask for changes to the plan."
            : design.turnRunning
              ? "Resuming: the architect's workspace is starting again. This can take a minute."
              : "The architect's workspace was saved while you were away. Your next message resumes it, which can take a minute."}{" "}
          {!design.turnRunning && !typing && hasPlan && !design.fresh && <FreshSession key={`${design.state}-${messages.length}`} runId={design.runId} />}
        </div>
      )}
      {runId && track?.to && <TrackSwitch key={`${track.current}-${track.to}`} runId={runId} track={track} />}
      <div className="timeline">
        {timeline}
        {typing && (
          <div className="message agent">
            {design && <div className="origin agent-origin">Architect agent</div>}
            <div className="bubble streaming">{streaming ? streaming : <span className="typing">{design ? "The architect is working…" : "Thinking…"}</span>}</div>
          </div>
        )}
        <div ref={bottom} />
      </div>
      {error && <div className="error-banner">{error}</div>}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <textarea
          value={draft}
          placeholder={
            design
              ? "Message the architect…"
              : kind === "run"
                ? "Ask about this run…"
                : kind === "subtask"
                  ? "Ask about this sub-task…"
                  : "Ask about runs, or start work on an issue…"
          }
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(draft);
            }
          }}
          rows={2}
          disabled={typing}
          aria-label="Message"
        />
        <button className="primary" type="submit" disabled={typing || !draft.trim()}>
          Send
        </button>
      </form>
    </section>
  );
}
