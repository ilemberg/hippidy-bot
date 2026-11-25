import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "hippidy-bot",
  description: "See and correct what the team's bot knows and does.",
};

const styles = `
  :root { color-scheme: light dark; --fg: #1a1a1a; --bg: #fafafa; --muted: #666; --accent: #4a154b; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #eee; --bg: #161616; --muted: #aaa; --accent: #e3b8e4; }
  }
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
  main { max-width: 40rem; margin: 0 auto; padding: 3rem 1rem; }
  h1 { font-size: 1.5rem; margin: 0 0 1.5rem; }
  .muted { color: var(--muted); }
  .notice { border-left: 3px solid var(--accent); padding: 0.25rem 0.75rem; margin: 1rem 0; }
  .button { display: inline-block; padding: 0.5rem 1rem; border: 1px solid var(--accent);
    border-radius: 6px; color: var(--accent); background: transparent; font: inherit;
    text-decoration: none; cursor: pointer; }
  pre { overflow-x: auto; padding: 0.75rem; border-radius: 6px; background: rgba(127,127,127,0.12); }
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <style>{styles}</style>
      </head>
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
