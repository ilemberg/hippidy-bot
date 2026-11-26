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
  h3 { font-size: 1rem; margin: 1.5rem 0 0.25rem; }
  .home { color: inherit; text-decoration: none; }
  .about p { margin: 0.5rem 0; }
  code { font-size: 0.9em; padding: 0 0.25rem; border-radius: 4px; background: rgba(127,127,127,0.15); }
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
  .notice-error { border-left-color: var(--danger); }
  .status-proposed { color: var(--accent); }
  .status-rejected, .status-superseded { color: var(--muted); }
  .search { display: flex; gap: 0.5rem; margin: 1rem 0 0.5rem; }
  .search input { flex: 1; min-width: 0; }
  input, textarea, select { font: inherit; color: inherit; background: transparent; padding: 0.4rem 0.5rem;
    border: 1px solid rgba(127,127,127,0.5); border-radius: 6px; box-sizing: border-box; }
  .filters { display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; font-size: 0.9rem; }
  .statement { font-size: 1.1rem; font-weight: 600; overflow-wrap: anywhere; }
  .facts { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; }
  .facts dt { color: var(--muted); }
  .facts dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
  .actions { margin: 1.5rem 0; }
  .buttons { display: flex; gap: 0.75rem; margin: 0.5rem 0; }
  .button-danger { border-color: var(--danger); color: var(--danger); }
  .edit label { display: block; margin: 0.75rem 0; }
  .edit textarea, .edit input, .edit select { display: block; width: 100%; margin-top: 0.25rem; }
  .change { font-size: 0.95rem; white-space: pre-wrap; }
  .edit fieldset { border: 0; padding: 0; margin: 0.75rem 0; }
  .edit fieldset label { margin: 0.25rem 0; }
  .edit input[type="radio"] { display: inline; width: auto; margin: 0 0.5rem 0 0; }
  .job-capped, .outcome-failed { color: var(--danger); }
  .job-paused, .outcome-silent, .outcome-skipped { color: var(--muted); }
  .outcome-said, .ticket-merged { color: var(--accent); }
  .ticket-closed, .ticket-stopped, .ticket-skipped, .ticket-done_elsewhere { color: var(--muted); }
  .table { overflow-x: auto; margin: 0.5rem 0 1rem; }
  .wakes { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  .wakes th, .wakes td { text-align: left; vertical-align: top; padding: 0.4rem 0.5rem 0.4rem 0;
    border-top: 1px solid rgba(127,127,127,0.25); }
  .wakes th { color: var(--muted); font-weight: normal; }
  .wakes td { overflow-wrap: anywhere; }
  .wakes td:first-child, .wakes .cost { white-space: nowrap; }
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
