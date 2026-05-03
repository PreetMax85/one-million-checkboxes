import Redis from "ioredis";

// ─────────────────────────────────────────────
// WHY THREE CONNECTIONS?
// ─────────────────────────────────────────────
//
// Redis has a rule: once a connection is in "subscribe mode",
// it can ONLY listen. It can't do SETBIT, GET, INCR, etc.
// So we need separate connections for different jobs:
//
//   redis      → general purpose: SETBIT, GETBIT, BITCOUNT, INCR, etc.
//   publisher  → sends messages to the Pub/Sub channel
//   subscriber → listens to messages from the Pub/Sub channel
//
// Three connections = three separate TCP sockets to Redis.
// That's fine — Redis handles thousands of connections easily.


function createRedisConnection() {
  const client = new Redis({
    // Read from environment variables so this works everywhere:
    // locally (localhost), Docker (container name), cloud (managed Redis URL).
    host: process.env.REDIS_HOST ?? "localhost",
    port: Number(process.env.REDIS_PORT) || 6379,

    // retryStrategy: what to do when connection drops.
    // "times" = how many retries have happened so far.
    // We wait longer each retry (exponential backoff), max 3 seconds.
    // Without this, if Redis blips, your server crashes.
    retryStrategy: (times) => {
      if (times > 10) return null; // give up after 10 retries
      return Math.min(times * 200, 3000); // wait 200ms, 400ms, ..., 3000ms
    },
  });

  // Log Redis errors instead of crashing.
  // Without this handler, Redis errors become uncaught exceptions → server crash.
  client.on("error", (err) => {
    console.error("Redis connection error:", err.message);
  });

  client.on("connect", () => {
    console.log("Redis connected");
  });

  return client;
}

// Three separate connections, each with the same config.
// Export all three so index.js can import what it needs.
export const redis      = createRedisConnection(); // reads/writes
export const publisher  = createRedisConnection(); // pub/sub publish
export const subscriber = createRedisConnection(); // pub/sub subscribe