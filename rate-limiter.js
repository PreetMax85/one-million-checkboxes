import { redis } from "./redis-connection.js";

// ─────────────────────────────────────────────
// HOW THIS RATE LIMITER WORKS
// ─────────────────────────────────────────────
//
// "Fixed window" rate limiting using Redis.
//
// Concept: every user gets a counter in Redis.
// Counter increments on each action.
// Counter expires after N seconds (the "window").
// If counter > limit → block. Else → allow.
//
// Example (WS_LIMIT=10, WS_WINDOW=1 second):
//
//   t=0.0s  User toggles checkbox 1  → INCR → count=1  → ALLOW
//   t=0.1s  User toggles checkbox 2  → INCR → count=2  → ALLOW
//   ...
//   t=0.5s  User toggles checkbox 10 → INCR → count=10 → ALLOW
//   t=0.6s  User toggles checkbox 11 → INCR → count=11 → BLOCK ✗
//   t=1.0s  Key expires in Redis      → counter resets to 0
//   t=1.1s  User toggles checkbox 12 → INCR → count=1  → ALLOW ✓
//
// Why Redis instead of a JS Map?
// Because if you run 2 servers, each server has its own JS memory.
// User could hit Server 1 (count=5) then Server 2 (count=5) = 10 total
// but each server thinks they only did 5. Redis is shared = correct.
//
// Why INCR + EXPIRE instead of EXPIRE always?
// EXPIRE resets the TTL every time. We only set it on first INCR (count===1).
// This means the window is fixed: starts at first request, ends N seconds later.
// If we set EXPIRE every time, the window would keep sliding → never expire.

// ── WEBSOCKET LIMITS ──────────────────────────────────────────
// 10 toggles per second per user. Feels fast enough for humans,
// blocks bots/spammers clicking at machine speed.
const WS_LIMIT  = 10;
const WS_WINDOW = 1; // seconds

// ── HTTP LIMITS ───────────────────────────────────────────────
// 60 requests per minute per IP for API endpoints.
// /api/state is fetched once on load, not repeatedly, so 60/min is generous.
const HTTP_LIMIT  = 60;
const HTTP_WINDOW = 60; // seconds


// ── WS RATE LIMIT ─────────────────────────────────────────────
// Called for every WebSocket event (checkbox toggle).
// identifier = userId (stable) rather than socketId (changes on reconnect).
// Returns: true = request allowed, false = request blocked.

export async function wsRateLimit(identifier) {
  const key = `rate:ws:${identifier}`;
  // INCR creates the key if it doesn't exist (starts at 0, increments to 1).
  // It returns the NEW value after incrementing.
  const count = await redis.incr(key);

  // Only set expiry on the FIRST increment.
  // If we set it every time, the window would never expire properly.
  if (count === 1) {
    await redis.expire(key, WS_WINDOW);
  }

  return count <= WS_LIMIT;
}


// ── HTTP RATE LIMIT ───────────────────────────────────────────
// Used as Express middleware. Same logic but for HTTP routes.
// Middleware signature = (req, res, next).
// Call next() to allow, return 429 to block.

export async function httpRateLimit(req, res, next) {
  // req.ip = IP address of the requester.
  // If behind a proxy (Nginx, Render, etc.), set trust proxy in Express:
  // app.set("trust proxy", 1)
  // Otherwise req.ip might always be "127.0.0.1" (the proxy's IP).
  const ip  = req.ip ?? req.socket.remoteAddress ?? "unknown";
  const key = `rate:http:${ip}`;

  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, HTTP_WINDOW);

    if (count > HTTP_LIMIT) {
      // 429 = "Too Many Requests" — standard HTTP status for rate limiting.
      // Retry-After header tells client how long to wait (standard convention).
      res.setHeader("Retry-After", HTTP_WINDOW);
      return res.status(429).json({
        error: "Rate limit exceeded.",
        retryAfter: HTTP_WINDOW,
      });
    }

    // Add headers so client can see their current usage.
    // X-RateLimit-* headers are an industry convention (not a standard).
    res.setHeader("X-RateLimit-Limit",     HTTP_LIMIT);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, HTTP_LIMIT - count));

    next(); // all good — continue to the actual route handler
  } catch (err) {
    // If Redis is down, don't block all requests — fail open.
    // In production you might want to fail closed (block all) for security.
    console.error("Rate limiter error:", err);
    next();
  }
}