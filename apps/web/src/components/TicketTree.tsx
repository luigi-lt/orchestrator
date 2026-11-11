import { useState } from "react";
import type { ConversationDto, TicketDto, TicketRunDto } from "@orch/contracts";

const label = (state: string) => state.replace(/_/g, " ");

/** "Run 2 · guided · executing": what a run row says about itself. */
export const runLabel = (run: TicketRunDto) => [`Run ${run.ordinal}`, run.track, label(run.state)].filter(Boolean).join(" · ");

/**
 * The side panel of the user view: conversations grouped by ticket (ticket, its runs newest first, and
 * under a guided run its sub-tasks), and the general chats below. A ticket opens by itself while it is active, waits for a decision or
 * holds the open conversation; the caret overrides that.
 */
export function TicketTree({
  tickets,
  chats,
  currentId,
  onOpen,
}: {
  tickets: TicketDto[];
  chats: ConversationDto[];
  currentId: string | undefined;
  onOpen: (conversationId: string) => void;
}) {
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  return (
    <nav className="ticket-tree" aria-label="Conversations">
      <div className="tree-section">Tickets</div>
      {tickets.map((ticket) => {
        const holdsCurrent = ticket.runs.some((r) => r.conversationId === currentId || r.subtasks.some((st) => st.conversationId === currentId));
        const open = toggled[ticket.key] ?? (ticket.active || ticket.pending > 0 || holdsCurrent);
        const newest = ticket.runs[0];
        return (
          <div key={ticket.key} className="ticket-group">
            <div className={`ticket-row ${holdsCurrent ? "current" : ""}`}>
              <button
                className="caret"
                aria-expanded={open}
                aria-label={`${open ? "Collapse" : "Expand"} ${ticket.repo}#${ticket.issueNumber}`}
                onClick={() => setToggled((t) => ({ ...t, [ticket.key]: !open }))}
              >
                {open ? "▾" : "▸"}
              </button>
              <button
                className="ticket-open"
                title={`${ticket.repo}#${ticket.issueNumber} · ${ticket.title}`}
                onClick={() => {
                  setToggled((t) => ({ ...t, [ticket.key]: true }));
                  if (newest?.conversationId) onOpen(newest.conversationId);
                }}
              >
                <span className="ticket-ref">
                  {ticket.repo.split("/")[1]}#{ticket.issueNumber}
                </span>
                <span className="title">{ticket.title}</span>
              </button>
              {ticket.pending > 0 ? (
                <span className="dot" title={`${ticket.pending} waiting for you`} />
              ) : (
                <span className={`state-mark ${ticket.active ? "active" : ticket.state}`} title={label(ticket.state)} />
              )}
            </div>
            {open &&
              ticket.runs.map((run) => (
                <div key={run.runId}>
                  <button
                    className={`run-row ${run.conversationId === currentId ? "active" : ""}`}
                    disabled={!run.conversationId}
                    onClick={() => run.conversationId && onOpen(run.conversationId)}
                  >
                    <span className="title">{runLabel(run)}</span>
                    {run.pending > 0 && <span className="dot" title={`${run.pending} waiting for you`} />}
                  </button>
                  {run.subtasks.map((st) => (
                    <button
                      key={st.key}
                      className={`run-row subtask-row ${st.conversationId === currentId ? "active" : ""}`}
                      title={`${st.title} · ${label(st.state)}`}
                      onClick={() => onOpen(st.conversationId)}
                    >
                      <span className="title">
                        {st.index + 1}. {st.title}
                      </span>
                      {st.pending > 0 ? (
                        <span className="dot" title={`${st.pending} waiting for you`} />
                      ) : (
                        <span className="muted small subtask-state">{label(st.state)}</span>
                      )}
                    </button>
                  ))}
                </div>
              ))}
          </div>
        );
      })}
      {tickets.length === 0 && <p className="muted small pad">No tickets yet.</p>}

      <div className="tree-section">Chats</div>
      {chats.map((c) => (
        <button key={c.id} className={`conversation-item ${c.id === currentId ? "active" : ""}`} onClick={() => onOpen(c.id)}>
          <span className="title">{c.title}</span>
        </button>
      ))}
      {chats.length === 0 && <p className="muted small pad">No chats yet.</p>}
    </nav>
  );
}
