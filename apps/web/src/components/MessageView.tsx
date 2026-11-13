import type { Component, MessageAuthor, MessageDto, OrchestratorCard } from "@orch/contracts";
import { FormBlock, TableBlock } from "./AgentBlocks";
import { OrchestratorCardView } from "./Cards";
import { SafeMarkdown } from "./SafeMarkdown";

/** Every agent message says which agent wrote it (AD-38). */
const AGENT_NAMES: Record<MessageAuthor, string> = { "front-door": "Assistant", architect: "Architect agent" };

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
        {/* Only orchestrator cards are drawn here: the card view knows every type and draws nothing for anything else. */}
        {message.components.map((c, i) => (
          <OrchestratorCardView key={i} card={c as OrchestratorCard} />
        ))}
      </div>
    );
  }
  return (
    <div className="message agent">
      <div className="origin agent-origin">{AGENT_NAMES[message.author ?? "front-door"]}</div>
      <div className="bubble">
        {message.text && <SafeMarkdown>{message.text}</SafeMarkdown>}
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
      return <SafeMarkdown>{component.markdown}</SafeMarkdown>;
    case "table":
      return <TableBlock table={component} />;
    case "form":
      return <FormBlock form={component} onSubmit={onSubmitForm} />;
    default:
      // System-only components never render from agent messages.
      return null;
  }
}
