import type { Brief, BriefLine } from "@hippidy/contracts";
import { briefLink, moreText } from "../../lib/briefs.ts";

// A brief's sections as the page shows them, on `/brief` and on the home page (slice 4.5).

export function BriefSections({
  brief,
  webBaseUrl,
  heading,
}: {
  brief: Brief;
  webBaseUrl: string;
  /** The level of each section's title, under the heading the brief sits in. */
  heading: "h3" | "h4";
}) {
  const Heading = heading;
  if (brief.sections.length === 0) {
    return <p className="muted">Nothing new: no brief would be sent.</p>;
  }
  return (
    <>
      {brief.sections.map((section) => {
        const more = moreText(section.more);
        return (
          <section key={section.kind}>
            <Heading>{section.title}</Heading>
            <ul>
              {section.lines.map((line, i) => (
                <li key={i}>
                  <Line line={line} webBaseUrl={webBaseUrl} />
                </li>
              ))}
            </ul>
            {more === undefined ? null : <p className="muted">{more}</p>}
          </section>
        );
      })}
    </>
  );
}

function Line({ line, webBaseUrl }: { line: BriefLine; webBaseUrl: string }) {
  const link = briefLink(line, webBaseUrl);
  switch (link.kind) {
    case "text":
      return <>{line.text}</>;
    case "app":
      return <a href={link.href}>{line.text}</a>;
    case "slack":
      return (
        <a href={link.href} target="_blank" rel="noreferrer">
          {line.text}
        </a>
      );
  }
}
