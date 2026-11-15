import { useState } from "react";
import type { ConversationDto, TicketDto, TicketRunDto } from "@orch/contracts";
import { SUBTASK_STATE_LABEL } from "./Cards";

const label = (state: string) => state.replace(/_/g, " ");

/** "Run 2 · guided · executing": what a run row says about itself. */
export const runLabel = (run: TicketRunDto) => [`Run ${run.ordinal}`, run.track, label(run.state)].filter(Boolean).join(" · ");

export const runPath = (runId: string) => `/runs/${runId}`;
export const subtaskPath = (runId: string, key: string) => `/runs/${runId}/subtasks/${encodeURIComponent(key)}`;

/**
 * The side panel of the user view: tickets, each with its runs newest first and, under a guided run, its
 * sub-tasks; every entry opens a page (AD-43, AD-44). The chats with the assistant are listed below. A ticket
 * opens by itself while it is active, waits for a decision or holds the open page; the caret overrides that.
 */
export function TicketTree({
  tickets,
  chats,
  currentPath,
  onOpen,
}: {
  tickets: TicketDto[];
  chats: ConversationDto[];
  currentPath: string;
  onOpen: (path: string) => void;
}) {
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const onPageOf = (runId: string) => currentPath === runPath(runId) || currentPath.startsWith(`${runPath(runId)}/`);

  return (
    <nav className="ticket-tree" aria-label="Work">
      <div className="tree-section">Tickets</div>
      {tickets.map((ticket) => {
        const holdsCurrent = ticket.runs.some((r) => onPageOf(r.runId));
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
                  if (newest) onOpen(runPath(newest.runId));
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
                    className={`run-row ${currentPath === runPath(run.runId) ? "active" : ""}`}
                    aria-current={currentPath === runPath(run.runId) ? "page" : undefined}
                    onClick={() => onOpen(runPath(run.runId))}
                  >
                    <span className="title">{runLabel(run)}</span>
                    {run.pending > 0 && <span className="dot" title={`${run.pending} waiting for you`} />}
                  </button>
                  {run.subtasks.map((st) => {
                    const path = subtaskPath(run.runId, st.key);
                    return (
                      <button
                        key={st.key}
                        className={`run-row subtask-row ${currentPath === path ? "active" : ""}`}
                        aria-current={currentPath === path ? "page" : undefined}
                        title={`${st.title} · ${SUBTASK_STATE_LABEL[st.state] ?? label(st.state)}`}
                        onClick={() => onOpen(path)}
                      >
                        <span className="title">
                          {st.index + 1}. {st.title}
                        </span>
                        {st.pending > 0 ? (
                          <span className="dot" title={`${st.pending} waiting for you`} />
                        ) : (
                          <span className="muted small subtask-state">{SUBTASK_STATE_LABEL[st.state] ?? label(st.state)}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}
          </div>
        );
      })}
      {tickets.length === 0 && <p className="muted small pad">No tickets yet.</p>}

      <div className="tree-section">Chats</div>
      {chats.map((c) => (
        <button key={c.id} className={`conversation-item ${currentPath === `/chat/${c.id}` ? "active" : ""}`} onClick={() => onOpen(`/chat/${c.id}`)}>
          <span className="title">{c.title}</span>
        </button>
      ))}
      {chats.length === 0 && <p className="muted small pad">No chats yet.</p>}
    </nav>
  );
}
