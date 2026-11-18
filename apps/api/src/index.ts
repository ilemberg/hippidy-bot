// Vercel entry point. Vercel serves the Hono app exported here, and only detects an entry
// file that creates the app itself, so the app is created here and configured in compose.ts.
import { Hono } from "hono";
import type { ApiEnv } from "./api/types.ts";
import { configureApp } from "./compose.ts";
import { createLogger } from "./log.ts";

const app = configureApp(new Hono<ApiEnv>(), { env: process.env, log: createLogger() });

export default app;
