import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { ConversationDto, MessageDto } from "@orch/contracts";
import { api, post, put, subscribe } from "../api";
import { useApp } from "../App";
import { MessageView } from "../components/MessageView";

export function ChatView() {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const { me, setToggleTarget } = useApp();
  const [conversations, setConversations] = useState<ConversationDto[]>([]);

  const loadConversations = useCallback(async () => setConversations(await api<ConversationDto[]>("/api/conversations")), []);

  useEffect(() => {
    void loadConversations();
    let timer: ReturnType<typeof setTimeout> | undefined;
    return subscribe((n) => {
      if (n.t === "msg" || n.t === "pending") {
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
        <nav className="conversation-list">
          {conversations.map((c) => (
            <button key={c.id} className={`conversation-item ${c.id === conversationId ? "active" : ""}`} onClick={() => navigate(`/chat/${c.id}`)}>
              <span className="title">{c.title}</span>
              {c.pending > 0 && <span className="dot" title={`${c.pending} waiting for you`} />}
            </button>
          ))}
          {conversations.length === 0 && <p className="muted small pad">No conversations yet.</p>}
        </nav>
      </aside>
      {conversationId ? <Conversation key={conversationId} id={conversationId} /> : <EmptyState onStart={() => void newConversation()} />}
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

function Conversation({ id }: { id: string }) {
  const [messages, setMessages] = useState<MessageDto[]>([]);
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
    const data = await api<{ messages: MessageDto[]; busy: boolean }>(`/api/conversations/${id}?after=${maxVersion.current}`);
    merge(data.messages);
    return data;
  }, [id, merge]);

  useEffect(() => {
    maxVersion.current = 0;
    void loadAfter().then((d) => setTyping(d.busy));
    return subscribe((n) => {
      if (n.t === "msg" && n.c === id && n.v > maxVersion.current) void loadAfter();
      if (n.t === "delta" && n.c === id) setStreaming((s) => s + n.text);
      if (n.t === "typing" && n.c === id) {
        setTyping(n.on);
        if (!n.on) setStreaming("");
      }
    });
  }, [id, loadAfter]);

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

  const timeline = useMemo(
    () => messages.map((m) => <MessageView key={m.id} message={m} onSubmitForm={submitForm} />),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages],
  );

  return (
    <section className="conversation">
      <div className="timeline">
        {timeline}
        {typing && (
          <div className="message agent">
            <div className="bubble">{streaming ? streaming : <span className="typing">Thinking…</span>}</div>
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
          placeholder="Ask about runs, or start work on an issue…"
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
