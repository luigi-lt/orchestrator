import { useCallback, useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate, useOutletContext } from "react-router-dom";
import type { ConversationDto, TicketDto } from "@orch/contracts";
import { api, post, subscribe } from "../api";
import { TicketTree } from "../components/TicketTree";

/** What the pages and chats of the user view share with the side panel. */
export interface UserNav {
  conversations: ConversationDto[];
  tickets: TicketDto[];
  loaded: boolean;
  newChat: () => Promise<void>;
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
      if (n.t === "msg" || n.t === "card" || n.t === "pending" || n.t === "run") {
        clearTimeout(timer);
        timer = setTimeout(() => void load(), 400);
      }
    });
  }, [load]);

  const newChat = useCallback(async () => {
    const c = await post<ConversationDto>("/api/conversations", {});
    await load();
    navigate(`/chat/${c.id}`);
  }, [load, navigate]);

  return (
    <div className="chat-layout">
      <aside className="sidebar">
        <button className="primary block" onClick={() => void newChat()}>
          + New chat
        </button>
        <TicketTree
          tickets={tickets}
          chats={conversations.filter((c) => c.kind === "general")}
          currentPath={location.pathname}
          onOpen={(path) => navigate(path)}
        />
      </aside>
      <Outlet context={{ conversations, tickets, loaded, newChat } satisfies UserNav} />
    </div>
  );
}
