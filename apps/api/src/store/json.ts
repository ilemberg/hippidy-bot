/**
 * JSON text for a jsonb column. Pass it as text and cast it in the SQL (`$1::text::jsonb`):
 * bound straight to a jsonb parameter, the production client stores a string as a JSON
 * string instead of the JSON it holds (decision 90).
 *
 * Postgres cannot hold two things JavaScript strings can: the null character, and half of a
 * surrogate pair on its own. Both are valid in what an agent or a tool may output, and either
 * would make the whole statement fail, so they are removed or replaced here, in values and
 * in keys.
 */
export function toJsonText(value: unknown): string {
  // `JSON.stringify` gives undefined for these; nothing JSON holds does.
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return "null";
  }
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "string") return storable(item);
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      const entries = Object.entries(item);
      if (entries.some(([key]) => storable(key) !== key)) {
        return Object.fromEntries(entries.map(([key, entry]) => [storable(key), entry]));
      }
    }
    return item;
  });
}

/** The string without what Postgres cannot store: no null character, no lone surrogate. */
export function storable(text: string): string {
  return text.toWellFormed().replaceAll("\u0000", "");
}
