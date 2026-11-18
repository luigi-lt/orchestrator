import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation, useParams } from "react-router-dom";
import type { ConversationDto, DesignStateDto, MessageDto, RunDto } from "@orch/contracts";
import { api, post, subscribe } from "../api";
import { useApp } from "../App";
import { MessageView } from "../components/MessageView";
import { runPath, subtaskPath } from "../components/TicketTree";
import { useUserNav } from "./UserLayout";

/** Where a conversation lives now: a run's and a sub-task's beside their pages, a chat on the start page (AD-44). */
export const homeOf = (c: ConversationDto): string =>
  c.focusedRunId && c.kind === "run"
    ? runPath(c.focusedRunId)
    : c.focusedRunId && c.kind === "subtask" && c.subtaskKey
      ? subtaskPath(c.focusedRunId, c.subtaskKey)
      : `/start?chat=${encodeURIComponent(c.id)}`;

/** Old links to /chat, /chat/new and /chat/<id> open where the conversation lives now. */
export function LegacyChat() {
  const { conversationId } = useParams();
  const { search } = useLocation();
  const { conversations, loaded } = useUserNav();
  if (!conversationId || conversationId === "new") {
    const about = new URLSearchParams(search).get("about");
    return <Navigate to={about ? `/start?about=${encodeURIComponent(about)}` : "/start"} replace />;
  }
  if (!loaded) return null;
  const c = conversations.find((x) => x.id === conversationId);
  return <Navigate to={c ? homeOf(c) : `/start?chat=${encodeURIComponent(conversationId)}`} replace />;
}

/**
 * A new chat with the assistant, in the agent panel of the start page. It is created with its first message, so
 * no empty chats are left behind. From a run's page the composer starts with the run named.
 */
export function NewChat({ about, onCreated, children }: { about: string | null; onCreated: (id: string) => void; children?: React.ReactNode }) {
  const { me } = useApp();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!about) return;
    void api<{ run: RunDto }>(`/api/runs/${encodeURIComponent(about)}`).then(
      ({ run }) => setDraft((d) => d || `About ${run.repo}#${run.issueNumber} (run ${run.id}): `),
      () => undefined,
    );
  }, [about]);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const c = await post<ConversationDto>("/api/conversations", {});
      await post(`/api/conversations/${c.id}/messages`, { text });
      onCreated(c.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <section className="conversation">
      <div className="timeline">
        <div className="assistant-intro">
          <p>
            Ask about any of your runs, or start work on an issue (for example <em>"work on {me?.repos[0] ?? "owner/repo"}#12"</em>). Decisions are taken on the run's
            page, never in a chat.
          </p>
        </div>
        {children}
      </div>
      {error && <div className="error-banner">{error}</div>}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          value={draft}
          autoFocus={!!about}
          placeholder="Ask about runs, or start work on an issue…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          disabled={busy}
          aria-label="Message to the assistant"
        />
        <button className="primary" type="submit" disabled={busy || !draft.trim()}>
          Send
        </button>
      </form>
    </section>
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

/**
 * One conversation: the messages, the state of the design session while it is open (the requester is talking
 * to the architect, AD-38), the reply as it streams, and the composer. A chat fills the page; a run's
 * conversation sits in the panel beside the run's page.
 */
export function Conversation({ id, kind }: { id: string; kind: ConversationDto["kind"] }) {
  const [messages, setMessages] = useState<MessageDto[]>([]);
  // Set while the run's design session is open: messages here go to the architect agent (AD-38).
  const [design, setDesign] = useState<DesignStateDto | null>(null);
  // Whether a message here reaches an agent now, and if not, why: decided by the orchestrator (AD-38).
  const [closed, setClosed] = useState<string | null>(null);
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
    const data = await api<{ conversation: ConversationDto; messages: MessageDto[]; busy: boolean; design: DesignStateDto | null; canSend: boolean; why: string | null }>(
      `/api/conversations/${id}?after=${maxVersion.current}`,
    );
    merge(data.messages);
    setDesign(data.design);
    setClosed(data.canSend ? null : (data.why ?? "No agent takes messages here."));
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
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    bottom.current?.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "end" });
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
              ? "Your messages here go to the architect. Ask about the code, set constraints, ask for changes to the plan; the plan on the page shows each new version."
              : design.turnRunning
                ? "Resuming: the architect's workspace is starting again. This can take a minute."
                : "The architect's workspace was saved while you were away. Your next message resumes it, which can take a minute."}{" "}
          {!design.turnRunning && !typing && design.hasPlan && !design.fresh && <FreshSession key={`${design.state}-${messages.length}`} runId={design.runId} />}
        </div>
      )}
      <div className="timeline" role="log" aria-live="polite" aria-relevant="additions" aria-label="Messages" aria-busy={typing}>
        {timeline}
        {messages.length === 0 && !typing && (
          <p className="muted small">{kind === "general" ? "Ask about your runs, or start work on an issue." : "No messages yet. What the orchestrator records and asks is on the page."}</p>
        )}
        {typing && (
          <div className="message agent">
            {design && <div className="origin agent-origin">Architect agent</div>}
            <div className="bubble streaming" aria-hidden={!!streaming}>{streaming ? streaming : <span className="typing">{design ? "The architect is working…" : "Thinking…"}</span>}</div>
          </div>
        )}
        <div ref={bottom} />
      </div>
      {error && <div className="error-banner">{error}</div>}
      {closed && !typing ? (
        <p className="composer-closed small" role="note">
          {closed}
        </p>
      ) : (
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <textarea
          value={draft}
          placeholder={design ? "Message the architect…" : "Ask about runs, or start work on an issue…"}
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
      )}
    </section>
  );
}
