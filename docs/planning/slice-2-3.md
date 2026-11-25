# Slice 2.3: web app and Slack sign-in

Status: **built 2026-11-25, not merged (decisions 193 and 194).** The wave is in `wave-2.md`;
the direction in `team-layer.md`, "How people reach it". G7 is answered (193). The Dashboard
v1 tickets SCRUM-9 (the web app) and SCRUM-10 (sign in with Slack) are this slice.

**Demo:** a member of the workspace opens the web app, presses "Sign in with Slack", and comes
back to a page that says "Signed in as <name>" and shows what the API says about them. Someone
who is not in the workspace is sent back with "Only members of the team's Slack workspace can
sign in", and gets no session.

## Rules this keeps

- **The API is the only door (2, 22).** The web app holds no database and no agent: it reads
  everything through the API's routes, from its own server.
- **The service token never reaches a browser (26, 38, 193).** The web app does not have it.
  It reaches the API as the signed-in person, with a token only the API accepts.
- **Fails closed (38).** With a variable missing, sign-in is off and the API refuses people;
  `/health` and the Slack bot keep working.
- **Secrets in Vercel, Production only (39).** Previews get none, so sign-in is off there.

## The parts

| Part | What |
|---|---|
| `apps/web` | A Next.js app (App Router), its own Vercel project. Four routes: `/`, `/auth/slack`, `/auth/slack/callback`, `/auth/signout` |
| `packages/contracts` | `GET /v1/me`'s response, and the person token's audience, issuer, lifetime and claims |
| `apps/api` | Accepts a person token beside the service token; puts the caller on the request; `GET /v1/me` |

## How sign-in works

1. `/` has no session cookie, so it shows **Sign in with Slack**, a link to `/auth/slack`.
2. `/auth/slack` makes a random `state` and `nonce`, puts both in a signed cookie that lives
   ten minutes and is sent only to the callback, and redirects to Slack's OpenID Connect page
   with scopes `openid profile email` and `team` set to the workspace.
3. Slack asks the person to allow it and sends them back to `/auth/slack/callback` with a
   `code` and the `state`.
4. The callback checks the `state` against the cookie, swaps the `code` for an id token at
   `openid.connect.token` with the app's client id and secret, and checks the id token:
   signed by one of Slack's keys (its JWKS), issued by `https://slack.com`, for this app,
   not expired, carrying the cookie's `nonce`, and with `https://slack.com/team_id` equal to
   the configured workspace. Any failure ends at `/` with a notice and no session.
5. It sets the session cookie: a signed token with the person's Slack user id, workspace
   and name, for eight hours. The sign-in cookie is deleted on every way out.
6. `/` reads the session and calls `GET /v1/me` from the server, with a person token it
   signs for that one call: the person, for the API, from the web app, for two minutes.
7. The API checks the token and the workspace, and answers
   `{ kind: "person", workspaceId, actorId, name }`. The page shows it.
8. **Sign out** posts to `/auth/signout`, which deletes the session cookie.

## Who may call what

| Route | Service token | Person |
|---|---|---|
| `GET /v1/me` | Yes: `{ kind: "service" }` | Yes |
| `GET /v1/conversations`, `/:id`, `/:id/events` | Yes | Yes (slice 2.4 needs them) |
| Every other `/v1` route, including every write and the projects and roles routes | Yes | No |
| `POST /v1/reconcile` | No: its own token | No |

## What it does not do yet

- **No revocation.** A session lasts eight hours and nothing ends it sooner, even when a
  person leaves the workspace. Short enough for a pilot of trusted people (175).
- **No per-person rights.** Everyone signed in reads every conversation, as everyone can
  talk to the bot in any channel it is in (174).
- **No browser tests.** They wait for the probe of decision 150 (SCRUM-12).

## By hand, the owner's

1. **Two secrets.** Make two values with `openssl rand -hex 32`: `WEB_API_SECRET` and
   `WEB_SESSION_SECRET`. They must differ.
2. **The web app's Vercel project.** New project from this repository, root directory
   `apps/web`, framework Next.js, everything else default. Note its production domain.
3. **The Slack app.** Put that domain in `slack/manifest.yaml` (`redirect_urls`) if it is not
   `hippidy-bot-web.vercel.app`, then update the app from the manifest and reinstall it. That
   adds the redirect URL `https://<domain>/auth/slack/callback` and the user scopes `openid`,
   `profile` and `email`.
4. **Variables, Production only.** In the API's project: `WEB_API_SECRET` and
   `SLACK_WORKSPACE_ID` (the team id, `T...`). In the web project: `SLACK_CLIENT_ID` and
   `SLACK_CLIENT_SECRET` (the Slack app's Basic Information page), `SLACK_WORKSPACE_ID`,
   `WEB_API_SECRET` (the same value), `WEB_SESSION_SECRET`, `API_BASE_URL`
   (`https://hippidy-bot.vercel.app`) and `WEB_BASE_URL` (`https://<domain>`). Redeploy both.

The README's "Slice 2.3 setup" has the same steps in detail.

## Done when

- A member of the workspace signs in on the production domain and sees "Signed in as
  <name>" and `kind: "person"` from the API.
- Someone signed in to Slack in another workspace is refused, and no session cookie is set.
- `GET /v1/me` without a token answers 401, and with the service token answers
  `{ kind: "service" }`.
- No response of the web app carries the service token, `WEB_API_SECRET` or a person token;
  the session cookie is HttpOnly, Secure and SameSite=Lax.
- A person token sent to `POST /v1/messages` is refused with 401.
- The Slack bot answers in a thread as before.
