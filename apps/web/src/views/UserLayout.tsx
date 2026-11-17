import { useCallback, useEffect, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate, useOutletContext } from "react-router-dom";
import type { ConversationDto, TicketDto } from "@orch/contracts";
import { api, subscribe } from "../api";
import { runPath, TicketTree } from "../components/TicketTree";

/** What the pages and chats of the user view share with the side panel. */
export interface UserNav {
  conversations: ConversationDto[];
  tickets: TicketDto[];
  loaded: boolean;
}

export const useUserNav = () => useOutletContext<UserNav>();

/**
 * The user view (AD-25, AD-44): the side panel with tickets → runs → sub-tasks, each opening a page, and the chats
 * with the assistant below; the page or chat that is open fills the rest.
 */
export function UserLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [tickets, setTickets] = useState<TicketDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Runs whose architect wrote while their page was not open (FR-C4); cleared when the page is opened.
  const [replied, setReplied] = useState<Set<string>>(new Set());
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;

  const load = useCallback(async () => {
    const [list, grouped] = await Promise.all([api<ConversationDto[]>("/api/conversations"), api<TicketDto[]>("/api/tickets")]);
    setConversations(list);
    setTickets(grouped);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    return subscribe((n) => {
      if (n.t === "msg") {
        const c = conversationsRef.current.find((x) => x.id === n.c);
        const runId = c?.agent === "architect" ? c.focusedRunId : null;
        if (runId && !pathRef.current.startsWith(runPath(runId))) setReplied((r) => new Set(r).add(runId));
      }
      if (n.t === "msg" || n.t === "card" || n.t === "pending" || n.t === "run") {
        clearTimeout(timer);
        timer = setTimeout(() => void load(), 400);
      }
    });
  }, [load]);

  useEffect(() => {
    setReplied((r) => {
      const open = [...r].filter((runId) => location.pathname.startsWith(runPath(runId)));
      if (!open.length) return r;
      const next = new Set(r);
      open.forEach((runId) => next.delete(runId));
      return next;
    });
  }, [location.pathname]);

  return (
    <div className="chat-layout">
      <aside className="sidebar">
        <button className="primary block" onClick={() => navigate("/chat/new")}>
          + New chat
        </button>
        <TicketTree
          tickets={tickets}
          chats={conversations.filter((c) => c.kind === "general")}
          currentPath={location.pathname}
          replied={replied}
          onOpen={(path) => navigate(path)}
        />
      </aside>
      <Outlet context={{ conversations, tickets, loaded } satisfies UserNav} />
    </div>
  );
}
