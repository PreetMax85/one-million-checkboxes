import Redis from "ioredis";

// ─────────────────────────────────────────────
// WHY THREE CONNECTIONS?
// ─────────────────────────────────────────────
// Redis rule: once a connection enters subscribe mode,
// it can ONLY listen — no SETBIT, INCR, GET etc.
// So we need three separate connections:
//   redis      → general reads/writes
//   publisher  → sends pub/sub messages
//   subscriber → listens to pub/sub messages

function createRedisConnection() {
  // REDIS_URL is set on Render (Upstash full URL: rediss://...)
  // Locally we use host + port from .env
  const client = process.env.REDIS_URL
    ? new Redis(process.env.REDIS_URL, {
        // Upstash requires TLS — ioredis handles rediss:// automatically.
        // maxRetriesPerRequest: null needed for subscribe connections.
        maxRetriesPerRequest: null,
        tls: {},
      })
    : new Redis({
        host: process.env.REDIS_HOST ?? "localhost",
        port: Number(process.env.REDIS_PORT) || 6379,
        maxRetriesPerRequest: null,
      });

  client.on("error", (err) => {
    console.error("Redis connection error:", err.message);
  });

  client.on("connect", () => {
    console.log("Redis connected");
  });

  return client;
}

export const redis      = createRedisConnection();
export const publisher  = createRedisConnection();
export const subscriber = createRedisConnection();