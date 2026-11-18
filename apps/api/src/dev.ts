// Local development server. Run with `pnpm dev` from the repo root.
import { serve } from "@hono/node-server";
import app from "./index.ts";

const port = Number(process.env.PORT ?? "3000");

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`hippidy-bot API listening on http://localhost:${info.port}`);
});
