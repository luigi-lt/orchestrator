import Markdown from "react-markdown";
import type { Component, MessageDto } from "@orch/contracts";
import { FormBlock, TableBlock } from "./AgentBlocks";
import { OrchestratorCardView } from "./Cards";

const SYSTEM = new Set(["work_item", "progress", "plan", "questions", "risk", "pull_request", "notice"]);

export function MessageView({ message, onSubmitForm }: { message: MessageDto; onSubmitForm: (title: string | undefined, values: Record<string, string>) => void }) {
  if (message.role === "user") {
    return (
      <div className="message user">
        <div className="bubble">{message.text}</div>
      </div>
    );
  }
  if (message.role === "orchestrator") {
    return (
      <div className="message orchestrator">
        <div className="origin" title="Posted by the orchestrator from its own records, not by the agent">
          ◆ Orchestrator
        </div>
        {message.components.map((c, i) => (SYSTEM.has(c.type) ? <OrchestratorCardView key={i} card={c as never} /> : null))}
      </div>
    );
  }
  return (
    <div className="message agent">
      <div className="bubble">
        {message.text && <Markdown>{message.text}</Markdown>}
        {message.components.map((c, i) => (
          <AgentComponentView key={i} component={c} onSubmitForm={onSubmitForm} />
        ))}
      </div>
    </div>
  );
}

function AgentComponentView({ component, onSubmitForm }: { component: Component; onSubmitForm: (title: string | undefined, values: Record<string, string>) => void }) {
  switch (component.type) {
    case "text":
      return <Markdown>{component.markdown}</Markdown>;
    case "table":
      return <TableBlock table={component} />;
    case "form":
      return <FormBlock form={component} onSubmit={onSubmitForm} />;
    default:
      // System-only components never render from agent messages.
      return null;
  }
}
