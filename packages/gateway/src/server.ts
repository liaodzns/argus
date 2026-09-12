/**
 * Gateway.
 *
 * Fans alerts and ticks out to browsers. Alert history from Postgres arrives
 * with the recording work at step 6; this serves the live socket only.
 */
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { ZodError } from "zod";
import { loadEnv } from "@argus/shared/config";
import { createFanOut } from "./ws.js";

let env: ReturnType<typeof loadEnv>;
try {
  env = loadEnv();
} catch (error) {
  if (!(error instanceof ZodError)) throw error;
  process.stderr.write("Invalid environment. Copy .env.example to .env and fill in:\n");
  for (const issue of error.issues) {
    process.stderr.write(`  ${issue.path.join(".") || "(root)"}: ${issue.message}\n`);
  }
  process.exit(1);
}

const app = Fastify({
  logger: process.stdout.isTTY
    ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } }
    : true,
});

const fanOut = createFanOut({ redisUrl: env.REDIS_URL, logger: app.log });

await app.register(websocket);

app.get("/health", async () => ({ ok: true, ...fanOut.stats }));

app.register(async (instance) => {
  instance.get("/ws", { websocket: true }, (socket) => {
    fanOut.add(socket);
    app.log.info({ clients: fanOut.stats.clients }, "client connected");
  });
});

await fanOut.start();
await app.listen({ port: env.GATEWAY_PORT, host: "0.0.0.0" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void (async () => {
      await fanOut.close();
      await app.close();
      process.exit(0);
    })();
  });
}
