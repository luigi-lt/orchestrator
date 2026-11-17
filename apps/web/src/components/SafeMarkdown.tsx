import Markdown from "react-markdown";

/**
 * Renders text written by an agent. Agents read untrusted tickets and code, so their text must not be able
 * to make the browser load or send anything: no images or embedded content, and links show where they
 * lead and open only on a click (architecture §7.5, §13).
 */
export function SafeMarkdown({ children }: { children: string }) {
  return (
    <Markdown
      skipHtml
      components={{
        img: ({ alt, src }) => <span className="blocked-image">[image not loaded: {alt || (typeof src === "string" ? src : "image")}]</span>,
        a: ({ href, children: label }) => {
          const text = typeof label === "string" ? label : Array.isArray(label) ? label.join("") : "";
          return (
            <>
              <a href={href} target="_blank" rel="noopener noreferrer nofollow" title={href}>
                {label}
              </a>
              {href && text !== href && <span className="link-target"> ({href})</span>}
            </>
          );
        },
      }}
    >
      {children}
    </Markdown>
  );
}
