import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Render source Markdown, never the live DOM (which contains controls and private tickets). */
export function renderMarkdownHtml(text: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        // Do not fetch or embed remote images when pasting into another application.
        img: ({ alt }) => <span>{alt ?? ""}</span>,
        pre: ({ children }) => <pre style={{ whiteSpace: "pre-wrap" }}>{children}</pre>,
      }}
    >
      {text}
    </ReactMarkdown>,
  );
}
