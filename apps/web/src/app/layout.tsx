import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "hippidy-bot",
  description: "See and correct what the team's bot knows and does.",
};

const styles = `
  :root { color-scheme: light dark; --fg: #1a1a1a; --bg: #fafafa; --muted: #666; --accent: #4a154b; --danger: #b03a2e; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #eee; --bg: #161616; --muted: #aaa; --accent: #e3b8e4; --danger: #ff8a7a; }
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
  a { color: var(--accent); }
  h2 { font-size: 1.15rem; margin: 0; }
  .bar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .sessions { list-style: none; padding: 0; margin: 1rem 0; }
  .session { padding: 0.75rem 0; border-top: 1px solid rgba(127,127,127,0.25); }
  .session p { margin: 0.25rem 0; overflow-wrap: anywhere; }
  .session-head { display: flex; flex-wrap: wrap; gap: 0.75rem; font-size: 0.9rem; }
  .session-title { font-weight: 600; }
  .latest { font-size: 0.95rem; }
  .state { font-weight: 600; }
  .state-working, .state-waiting_for_start { color: var(--accent); }
  .state-failed { color: var(--danger); }
  footer { margin-top: 2rem; font-size: 0.9rem; }
  .inline { display: inline; }
  .link { padding: 0; border: 0; background: none; color: var(--accent); font: inherit;
    text-decoration: underline; cursor: pointer; }
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
