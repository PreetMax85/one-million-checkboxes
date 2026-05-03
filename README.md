# One Million Checkboxes ☑️

A real-time collaborative web app where users interact with a grid of 1,000,000 checkboxes. Built from scratch with WebSockets, Redis, custom rate limiting, and OIDC authentication.
 
Demo video: [YouTube link](https://youtube.com)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | HTML, CSS, Vanilla JS (virtual scroll) |
| Backend | Node.js, Express 5 |
| Real-time | Socket.IO (WebSockets) |
| State storage | Redis (bitmap + hash + sorted set) |
| Auth | Custom OIDC provider — Authorization Code Flow + PKCE |
| Sessions | express-session |
| Deployment | Render |

---

## Features

- **1,000,000 checkboxes** rendered efficiently via virtual scroll — only ~200 DOM nodes at a time
- **Real-time sync** — toggle a checkbox, every connected user sees it instantly
- **Color identity** — logged-in users get a unique persistent color; their checked boxes glow in that color
- **Leaderboard** — tracks toggle counts per user via Redis sorted set
- **Activity feed** — live scrolling ticker of recent toggles with colored usernames
- **Custom rate limiting** — built from scratch using Redis INCR + EXPIRE, no external packages
- **Redis Pub/Sub** — scales across multiple server instances
- **OIDC authentication** — Authorization Code Flow with PKCE (S256)
- **State persistence** — Redis bitmap survives page refreshes and server restarts

---

## How to Run Locally

### Prerequisites
- Node.js 18+
- pnpm (`npm i -g pnpm`)
- Docker (for Redis)

### Steps

```bash
# 1. Clone the repo
git clone https://github.com/PreetMax85/one-million-checkboxes
cd one-million-checkboxes

# 2. Install dependencies
pnpm install

# 3. Start Redis via Docker
docker compose up -d

# 4. Set up environment
cp .env.example .env
# Open .env and fill in your values (see Environment Variables section)

# 5. Start the server
pnpm dev

# 6. Open http://localhost:8000
```

---

## Environment Variables

Copy `.env.example` to `.env` and fill in:

```env
PORT=8000
NODE_ENV=development

REDIS_HOST=localhost
REDIS_PORT=6379

SESSION_SECRET= # generate using:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

AUTH_ISSUER=https://custom-oidc-provider.onrender.com
CLIENT_ID= # from OIDC provider client registration
CLIENT_SECRET= # from OIDC provider client registration
REDIRECT_URI=http://localhost:8000/auth/callback
```

---

## Redis Setup

Redis runs via Docker Compose. The `docker-compose.yml` starts a Valkey instance (Redis-compatible):

```bash
docker compose up -d      # start
docker compose down       # stop
docker compose down -v    # stop + wipe all checkbox state
```

Data persists across restarts via a Docker volume (`valkey-data`).

### Redis keys used

| Key | Type | Purpose |
|---|---|---|
| `checkbox-state` | Bitmap | 1M bits — one per checkbox (1=checked, 0=unchecked) |
| `checkbox:colors` | Hash | `index → hsl(...)` color of the user who checked it |
| `leaderboard` | Sorted Set | `userName → toggle count` |
| `rate:ws:<userId>` | String | WebSocket rate limit counter per user |
| `rate:http:<ip>` | String | HTTP rate limit counter per IP |

---

## Auth Flow (OIDC + PKCE)

```
1. User clicks "Claim your color"
   → GET /auth/login
   → Server generates: code_verifier (random), code_challenge (SHA256 of verifier), state (CSRF token)
   → Stores verifier + state in session (server-side)
   → Redirects to: https://custom-oidc-provider.onrender.com/authorize
     with: client_id, redirect_uri, response_type=code, scope=openid profile email,
           state, code_challenge, code_challenge_method=S256

2. User logs in on the OIDC provider
   → Provider redirects back to: /auth/callback?code=xxx&state=xxx

3. GET /auth/callback
   → Validates state matches session (CSRF check)
   → POST /token with: code, code_verifier, client_id, client_secret, redirect_uri
   → OIDC server verifies: SHA256(verifier) === stored challenge
   → Returns: access_token, id_token
   → GET /userinfo with Bearer token → gets: sub, email, name
   → Saves user to session: { id: sub, email, name }
   → Redirects to /

4. Socket.IO connection
   → io.engine.use(sessionMiddleware) runs on WS handshake
   → Session is populated → socket.data.userId + userName set
   → Server derives user's unique color from userId
   → Emits server:auth-status with color to that client
```

**Why PKCE?** If an attacker intercepts the `?code=` in the redirect URL, they can't exchange it for tokens — they don't have the `code_verifier` that was stored server-side. The code is useless without it.

---

## WebSocket Flow

```
Client connects
  → io.engine.use: session middleware runs on handshake
  → io.use: user attached to socket from session
  → "connection": user count incremented, auth status emitted

Client toggles checkbox
  → socket.emit("client:checkbox:change", { index, checked })
  → Server: auth check → input validation → rate limit check
  → redis.setbit("checkbox-state", index, 1/0)      — store state
  → redis.hset("checkbox:colors", index, color)      — store color
  → redis.zincrby("leaderboard", 1, userName)        — update score
  → publisher.publish(PUBSUB_CHANNEL, payload)       — tell all servers

Redis Pub/Sub subscriber receives message
  → io.emit("server:checkbox:change", { index, checked, color, userName })
  → All connected browsers update that checkbox instantly
```

**Why Pub/Sub?** If you run 3 server instances, `io.emit()` only reaches users connected to that server. Publishing to Redis delivers the message to ALL server instances, each of which does `io.emit()` to their own clients. Every user gets the update regardless of which server they're connected to.

---

## Rate Limiting Logic

Built manually — no `express-rate-limit` package.

**Algorithm: Fixed Window using Redis INCR + EXPIRE**

```
On each action (toggle / API request):
  1. INCR rate:<identifier>     → increment counter (creates key if missing, starts at 1)
  2. If count === 1: EXPIRE key N seconds   → start the window (only on first hit)
  3. If count > limit → reject with 429
  4. Else → allow

After N seconds: key expires automatically → counter resets → new window starts
```

**Limits:**
- WebSocket (checkbox toggle): 10 per second per userId
- HTTP (/api/state): 60 per minute per IP

**Why userId not socketId for WS?** socketId changes on every reconnect — a user could bypass limits by reconnecting. userId is stable across sessions.

**Why not set EXPIRE on every hit?** That would keep resetting the window — the counter would never expire. Setting it only when `count === 1` means the window is fixed: starts on first request, resets N seconds later regardless of activity.

---