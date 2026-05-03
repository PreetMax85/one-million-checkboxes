import http from "node:http";
import path from "node:path";
import crypto from "node:crypto"; // built-in — for PKCE SHA256 hashing. No install needed.
import express from "express";
import session from "express-session";
import { Server } from "socket.io";
import { publisher, subscriber, redis } from "./redis-connection.js";
import { wsRateLimit, httpRateLimit } from "./rate-limiter.js";

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
const CHECKBOX_STATE_KEY  = "checkbox-state";
const CHECKBOX_COLORS_KEY = "checkbox:colors";   // Redis hash: index → color
const CHECKBOX_COUNT      = 1_000_000;
const PUBSUB_CHANNEL      = "internal-server:checkbox:change";


// ─────────────────────────────────────────────
// COLOR DERIVATION
// ─────────────────────────────────────────────
// Turns any string (userId or socketId) into a consistent HSL color.
// MUST be identical to the frontend version — both sides derive
// the same color independently, without talking to each other.
//
// Step by step:
//   1. Loop each character → build a 32-bit integer "hash"
//   2. Map hash → hue (0–360°)
//   3. Return HSL — same saturation/lightness for all, only hue differs
//      so every user gets an equally vibrant color
//
// We skip hues 55–95° because that's our UI accent (yellow-green).
// We don't want user colors blending into the UI chrome.
function getUserColor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash) + id.charCodeAt(i);
    hash |= 0; // clamp to 32-bit int (prevents float drift)
  }
  const hue      = Math.abs(hash) % 360;
  const adjusted = (hue >= 55 && hue <= 95) ? (hue + 130) % 360 : hue;
  return `hsl(${adjusted}, 80%, 62%)`;
}


async function main() {
  const PORT = process.env.PORT ?? 8000;
  const app    = express();
  const server = http.createServer(app);
  const io     = new Server(server, { cors: { origin: "*" } });

  // ── TRUST PROXY ───────────────────────────────────────────────
  // CRITICAL for Render/Railway/Heroku.
  // These platforms proxy all traffic through a load balancer.
  // Without this, req.ip is always "127.0.0.1" on every request.
  // Our rate limiter keys on req.ip — without this, ALL users share
  // one bucket and everyone gets 429'd together. Very bad.
  // "1" = trust exactly one hop (the platform's LB).
  app.set("trust proxy", 1);


  // ── MIDDLEWARE ────────────────────────────────────────────────
  app.use(express.json());

  // Extract session into a variable BEFORE passing to app.use().
  // This is the critical step — we need ONE instance shared between
  // Express and Socket.IO. If you inline it (session({...})) in both
  // places you get TWO separate session stores that don't talk to each
  // other. One variable = one store = one source of truth.
  const sessionMiddleware = session({
    secret:            process.env.SESSION_SECRET ?? "dev-secret-change-this",
    resave:            false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure:   process.env.NODE_ENV === "production",
      maxAge:   86400000, // 24 hours
      // sameSite: 'lax' = send cookie on top-level cross-site GET navigations.
      // This is what OAuth redirect flows are — browser leaves your site, goes to
      // the OIDC provider, then comes back. Without 'lax', some browsers drop the
      // cookie on the return trip → session lost → state mismatch → auth broken.
      sameSite: "lax",
    },
  });

  // 1. Express HTTP routes get session (login, callback, /auth/me, /api/*)
  app.use(sessionMiddleware);
  app.use(express.static(path.resolve("./public")));

  // 2. Socket.IO engine gets the SAME session middleware.
  // io.engine.use() runs on the raw WebSocket upgrade request —
  // before Socket.IO processes it. This populates socket.request.session
  // so that io.use() below can read it.
  //
  // Without this line:
  //   socket.request.session = undefined → no userId → no color → auth broken
  // With this line:
  //   socket.request.session = { user: {...} } → auth works ✓
  io.engine.use(sessionMiddleware);


  // ── SOCKET.IO AUTH MIDDLEWARE ─────────────────────────────────
  // Now socket.request.session is populated (because io.engine.use above).
  // This middleware runs after the handshake, before "connection" fires.
  // We pull user from session and attach to socket.data for use in handlers.
  io.use((socket, next) => {
    const user = socket.request.session?.user;
    if (user) {
      socket.data.userId   = user.id;
      socket.data.userName = user.name;
    }
    // Always call next() — anon users connect too, just get socketId-based color.
    next();
  });


  // ── REDIS PUB/SUB ─────────────────────────────────────────────
  await subscriber.subscribe(PUBSUB_CHANNEL);

  subscriber.on("message", (channel, message) => {
    if (channel !== PUBSUB_CHANNEL) return;

    const payload = JSON.parse(message);
    // Strip socketId from the payload before sending to clients —
    // clients don't need to know about internal socket IDs.
    const { socketId, ...eventData } = payload;

    // Find the socket that SENT this toggle.
    // socket.broadcast.emit() sends to everyone on THIS server EXCEPT that socket.
    // This prevents the sender getting their own event echoed back,
    // which would cause double state updates and broken counts.
    const originSocket = io.sockets.sockets.get(socketId);
    if (originSocket) {
      // Sender is on this server — broadcast to everyone except them.
      originSocket.broadcast.emit("server:checkbox:change", eventData);
    } else {
      // Sender is on a different server OR already disconnected.
      // Safe to emit to everyone on this server.
      io.emit("server:checkbox:change", eventData);
    }
  });


  // ── CONNECTED USERS TRACKING ──────────────────────────────────
  let connectedUsers = 0;


  // ── SOCKET CONNECTION ─────────────────────────────────────────
  io.on("connection", (socket) => {
    connectedUsers++;
    io.emit("server:stats", { connectedUsers });

    // Tell THIS socket their auth state + pre-computed color.
    // Anon  → color derived from socketId (changes on refresh — acceptable)
    // Authed → color derived from userId  (same forever — their identity)
    socket.emit("server:auth-status", {
      isAuthed: !!socket.data.userId,
      userName: socket.data.userName ?? null,
      userId:   socket.data.userId   ?? null,
      myColor:  getUserColor(socket.data.userId ?? socket.id),
    });

    console.log(`[+] ${socket.id} | authed: ${!!socket.data.userId} | total: ${connectedUsers}`);


    // ── CHECKBOX TOGGLE ───────────────────────────────────────
    socket.on("client:checkbox:change", async (data) => {

      // 1. VALIDATE — never trust client input
      const { index, checked } = data;
      if (
        typeof index   !== "number"  ||
        typeof checked !== "boolean" ||
        index < 1 || index > CHECKBOX_COUNT ||
        !Number.isInteger(index)
      ) {
        socket.emit("server:error", { code: "INVALID_DATA", message: "Bad data." });
        return;
      }

      // 2. RATE LIMIT
      // Authed → limit by userId (stable across reconnects)
      // Anon   → limit by socketId (per browser session)
      const limitKey = socket.data.userId ?? socket.id;
      const allowed  = await wsRateLimit(limitKey);
      if (!allowed) {
        socket.emit("server:rate-limited", { message: "Too fast! Slow down.", retryAfter: 1000 });
        return;
      }

      // 3. DERIVE COLOR FOR THIS USER
      // Authed → same color every session (userId never changes)
      // Anon   → color tied to this socket session
      const color = getUserColor(socket.data.userId ?? socket.id);

      // 4. WRITE CHECKBOX STATE (bitmap)
      // CRITICAL: Redis SETBIT is 0-based. Client sends 1-based index.
      // setbit(key, 1, 1) sets bit at offset 1 = SECOND bit.
      // Decoding: offset 1 → i=1 → checkedState.set(2) → wrong box highlighted.
      // Fix: subtract 1 so checkbox #1 → offset 0 → first bit → correct.
      await redis.setbit(CHECKBOX_STATE_KEY, index - 1, checked ? 1 : 0);

      // 5. WRITE COLOR (hash)
      // Stores which color "owns" each checked box.
      // On uncheck → remove the entry so unchecked boxes have no color.
      // Redis HASH is like a JS object: { field: value, field: value }
      //   HSET key field value  →  obj[field] = value
      //   HDEL key field        →  delete obj[field]
      if (checked) {
        await redis.hset(CHECKBOX_COLORS_KEY, index, color);
      } else {
        await redis.hdel(CHECKBOX_COLORS_KEY, index);
      }

      // 6. LEADERBOARD — increment this user's toggle count
      // ZINCRBY adds "increment" to member's score in a sorted set.
      // Redis keeps sorted sets automatically sorted — no manual sorting needed.
      // We track by displayName so the leaderboard is human-readable.
      const displayName = socket.data.userName ?? `Guest-${socket.id.slice(0, 6)}`;
      await redis.zincrby("leaderboard", 1, displayName);

      // 7. PUBLISH — tell ALL servers about this change
      // Include color + userName so receiving clients can render immediately
      // without an extra lookup.
      // Include socketId so the subscriber can EXCLUDE the sender.
      // Without this, io.emit() in subscriber sends the event back to the
      // sender who already did an optimistic update → double state change.
      await publisher.publish(PUBSUB_CHANNEL, JSON.stringify({
        index,
        checked,
        color:    checked ? color : null,
        userName: displayName,
        socketId: socket.id,   // ← the sender's socket — subscriber will skip them
      }));

      console.log(`[CB] ${displayName} → #${index} = ${checked} (${color})`);
    });


    // ── DISCONNECT ────────────────────────────────────────────
    socket.on("disconnect", (reason) => {
      connectedUsers = Math.max(0, connectedUsers - 1);
      io.emit("server:stats", { connectedUsers });
      console.log(`[-] ${socket.id} | ${reason} | total: ${connectedUsers}`);
    });
  });


  // ─────────────────────────────────────────────
  // HTTP ROUTES
  // ─────────────────────────────────────────────

  // GET /api/state — initial page load data
  // Returns bitmap (which boxes checked) + colors (what color each box is)
  // Uses Promise.all so all 3 Redis calls run in parallel, not one-by-one.
  app.get("/api/state", httpRateLimit, async (req, res) => {
    try {
      const [buf, checkedCount, colors] = await Promise.all([
        redis.getBuffer(CHECKBOX_STATE_KEY),
        redis.bitcount(CHECKBOX_STATE_KEY),
        redis.hgetall(CHECKBOX_COLORS_KEY), // { "42": "hsl(...)", "1337": "hsl(...)" }
      ]);

      res.json({
        bits:         buf ? buf.toString("base64") : "",
        checkedCount: checkedCount ?? 0,
        total:        CHECKBOX_COUNT,
        colors:       colors ?? {}, // empty object if nothing toggled yet
      });
    } catch (err) {
      console.error("/api/state error:", err);
      res.status(500).json({ error: "Failed to fetch state" });
    }
  });


  // GET /api/leaderboard — top 10 players
  // ZREVRANGE = sorted set from highest to lowest, positions 0–9
  // WITHSCORES = include the score in the result array
  app.get("/api/leaderboard", async (req, res) => {
    try {
      // Redis returns: ["Preet", "42", "Hitesh", "18", ...]
      // Alternating: name at even index, score at odd index
      const raw     = await redis.zrevrange("leaderboard", 0, 9, "WITHSCORES");
      const entries = [];
      for (let i = 0; i < raw.length; i += 2) {
        entries.push({
          name:  raw[i],
          score: parseInt(raw[i + 1]),
          color: getUserColor(raw[i]), // show their color next to their name
        });
      }
      res.json(entries);
    } catch (err) {
      console.error("/api/leaderboard error:", err);
      res.status(500).json({ error: "Failed to load leaderboard" });
    }
  });


  // GET /api/my-score — personal toggle count for logged-in user
  app.get("/api/my-score", async (req, res) => {
    if (!req.session?.user) return res.json({ score: 0 });
    const score = await redis.zscore("leaderboard", req.session.user.name);
    res.json({ score: parseInt(score ?? 0) });
  });


  // GET /health
  app.get("/health", async (req, res) => {
    try {
      await redis.ping();
      res.json({ healthy: true, connectedUsers });
    } catch {
      res.status(503).json({ healthy: false, error: "Redis unreachable" });
    }
  });


  // ── AUTH ROUTES — PKCE + OIDC Authorization Code Flow ───────────
  //
  // PKCE = "Proof Key for Code Exchange".
  // Problem it solves: if someone intercepts the ?code= in the redirect URL,
  // they could exchange it for tokens. PKCE prevents this.
  //
  // How PKCE works:
  //   1. /auth/login generates a random "code_verifier" (secret)
  //   2. Hashes it with SHA256 → "code_challenge" (public)
  //   3. Sends code_challenge to OIDC server with the auth request
  //   4. Stores code_verifier in session (secret, server-side only)
  //   5. /auth/callback sends code_verifier to /token endpoint
  //   6. OIDC server hashes verifier → must match challenge sent in step 3
  //   7. If match → tokens issued. If not → rejected.
  //   Intercepted code is useless without the verifier. ✓
  //
  // "state" param = CSRF protection.
  //   Random value → sent to OIDC → must come back in callback.
  //   Prevents attackers from tricking your callback into processing
  //   their auth code instead of the real user's.

  // ── PKCE HELPERS ──────────────────────────────────────────────
  // generateVerifier: 32 random bytes → base64url string (no +/=/chars)
  // This is the secret we keep in session and send to /token later.
  function generateVerifier() {
    return crypto.randomBytes(32).toString("base64url");
  }

  // generateChallenge: SHA256(verifier) → base64url
  // This is what we send publicly to the OIDC /authorize endpoint.
  // The OIDC server stores it, then verifies our verifier matches on /token.
  function generateChallenge(verifier) {
    return crypto.createHash("sha256").update(verifier).digest("base64url");
  }

  // GET /auth/login
  // 1. Generate PKCE pair + random state
  // 2. Save verifier + state in session (server-side, not visible to browser)
  // 3. Redirect browser to OIDC /authorize with challenge + state
  app.get("/auth/login", (req, res) => {
    const verifier  = generateVerifier();
    const challenge = generateChallenge(verifier);
    // state = random CSRF token — must come back in callback unchanged
    const state     = crypto.randomBytes(16).toString("hex");

    // Store both in session. These are read in /auth/callback.
    // session is server-side — browser only has an opaque cookie ID.
    req.session.pkce_verifier = verifier;
    req.session.oauth_state   = state;

    const params = new URLSearchParams({
      client_id:             process.env.CLIENT_ID,
      redirect_uri:          process.env.REDIRECT_URI,
      response_type:         "code",
      scope:                 "openid profile email",
      state,
      code_challenge:        challenge,
      code_challenge_method: "S256", // SHA256 — only method your OIDC server accepts
    });

    // CRITICAL: explicitly save session before redirecting.
    // Without this, there's a race: browser follows the redirect to OIDC server
    // and back to /callback before the session write completes.
    // Result: pkce_verifier is undefined in /callback → token exchange fails.
    req.session.save((err) => {
      if (err) {
        console.error("Session save failed:", err);
        return res.status(500).send("Session error. Try again.");
      }
      res.redirect(`${process.env.AUTH_ISSUER}/authorize?${params}`);
    });
  });

  // GET /auth/callback
  // Called by OIDC server after user logs in.
  // URL looks like: /auth/callback?code=xxx&state=xxx
  app.get("/auth/callback", async (req, res) => {
    const { code, state } = req.query;

    // ── 1. VALIDATE STATE (CSRF check) ────────────────────────
    // If state doesn't match what we stored → someone is tampering.
    // This is not paranoia — it's required by the OAuth 2.0 spec.
    if (!state || state !== req.session.oauth_state) {
      console.error("State mismatch — possible CSRF attack");
      return res.status(400).send("Invalid state parameter. Please try logging in again.");
    }

    if (!code) return res.status(400).send("Missing authorization code.");

    // Pull verifier from session — we need it for the token exchange.
    const verifier = req.session.pkce_verifier;
    if (!verifier) return res.status(400).send("Missing PKCE verifier. Session may have expired.");

    // Clean up PKCE/state from session — one-time use only.
    delete req.session.pkce_verifier;
    delete req.session.oauth_state;

    try {
      // ── 2. EXCHANGE CODE FOR TOKENS ───────────────────────────
      // Server-to-server call — browser is not involved here.
      // We send: the code, our verifier, client credentials.
      // OIDC server: hashes verifier → compares to stored challenge → issues tokens.
      // Log what we're sending — helps verify REDIRECT_URI matches exactly
      console.log("[/token] Sending to:", `${process.env.AUTH_ISSUER}/token`);
      console.log("[/token] redirect_uri:", process.env.REDIRECT_URI);
      console.log("[/token] client_id:", process.env.CLIENT_ID);
      console.log("[/token] verifier length:", verifier?.length);

      // Sending JSON — your OIDC server uses express.json() middleware.
      // Form-encoded bodies (application/x-www-form-urlencoded) are ignored by
      // express.json() → req.body is undefined → Zod throws "expected object,
      // received undefined". JSON body fixes this.
      // (OIDC spec says form-encoded is standard, but custom servers can differ.)
      const tokenBody = {
        grant_type:    "authorization_code",
        code,
        redirect_uri:  process.env.REDIRECT_URI,
        client_id:     process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
        code_verifier: verifier,
      };

      const tokenRes = await fetch(`${process.env.AUTH_ISSUER}/token`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(tokenBody),
      });

      // Log HTTP status so we can see if OIDC server returned 4xx/5xx
      console.log("[/token] HTTP status:", tokenRes.status);

      const tokens = await tokenRes.json();
      console.log("[/token] Response body:", JSON.stringify(tokens));

      if (!tokens.access_token) {
        // tokens likely contains: { error: "...", error_description: "..." }
        // Common errors:
        //   invalid_grant        → code expired or already used (codes are one-time)
        //   invalid_client       → wrong client_id or client_secret
        //   redirect_uri_mismatch → REDIRECT_URI in .env ≠ what you registered
        //   invalid_request      → PKCE verifier doesn't match stored challenge
        const reason = tokens.error_description ?? tokens.error ?? "unknown";
        console.error("[/token] Exchange failed:", reason, tokens);
        return res.status(400).send(`Token exchange failed: ${reason}`);
      }

      // ── 3. FETCH USER INFO ────────────────────────────────────
      // /userinfo is a standard OIDC endpoint.
      // Returns: { sub, email, email_verified, given_name, family_name, name }
      // "sub" = subject = unique stable user ID. Never changes even if name/email does.
      const userRes = await fetch(`${process.env.AUTH_ISSUER}/userinfo`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });

      if (!userRes.ok) {
        console.error("Userinfo fetch failed:", userRes.status);
        return res.status(500).send("Failed to fetch user profile.");
      }

      const user = await userRes.json();

      // ── 4. SET SESSION ────────────────────────────────────────
      // Store minimal user info — don't store tokens in session.
      // sub (subject) is the stable unique ID — use it as your user ID.
      // name comes from your OIDC server's userinfo response.
      req.session.user = {
        id:    user.sub,
        email: user.email,
        name:  user.name ?? user.given_name ?? user.email, // fallback chain
      };

      // Redirect back to app — user is now logged in.
      res.redirect("/");

    } catch (err) {
      console.error("Auth callback error:", err);
      res.status(500).send("Authentication failed. Please try again.");
    }
  });

  // GET /auth/logout
app.get("/auth/logout", (req, res) => {
  req.session.destroy(async (err) => {
    if (err) console.error("Session destroy error:", err);

    // Clear the OIDC provider's SSO session too.
    // Without this, the oidc_session cookie on onrender.com survives
    // and the next login skips the login screen entirely.
    try {
      await fetch(`${process.env.AUTH_ISSUER}/logout`, { method: "POST" });
    } catch {
      // Don't block logout if provider is unreachable
    }

    res.redirect("/");
  });
});

  // GET /auth/me
  // Frontend calls this on page load to check login status.
  // Returns user object if logged in, 401 if not.
  // Used by init() in index.html to decide auth UI state.
  app.get("/auth/me", (req, res) => {
    if (!req.session?.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    res.json(req.session.user);
  });


  // ── START + GRACEFUL SHUTDOWN ─────────────────────────────────
  server.listen(PORT, () => console.log(`Server → http://localhost:${PORT}`));

  async function shutdown() {
    await Promise.all([redis.quit(), publisher.quit(), subscriber.quit()]);
    server.close(() => process.exit(0));
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT",  shutdown);
}

main();