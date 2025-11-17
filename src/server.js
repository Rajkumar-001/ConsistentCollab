import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import WebSocket, { WebSocketServer } from "ws";
import * as Y from "yjs";
import Redis from "ioredis";
import { v4 as uuidv4 } from "uuid";
import RoomManager from "./roomManager.js";
import {
  register,
  connectedClients,
  updatesTotal,
  messagesSent,
} from "./metrics.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const PORT = parseInt(process.env.PORT || "1234", 10);
const INSTANCE_ID = process.env.INSTANCE_ID || uuidv4();

console.log(`[Server] Starting instance: ${INSTANCE_ID}`);
console.log(`[Server] Port: ${PORT}`);
console.log(`[Server] Redis URL: ${REDIS_URL}`);

// Redis clients
const redisPub = new Redis(REDIS_URL);
const redisSub = new Redis(REDIS_URL);

// Room manager
const roomManager = new RoomManager(redisPub);

// Express app for health and metrics endpoints
const app = express();

// Serve static demo client
app.use(express.static(path.join(__dirname, "clientDemo")));

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    instanceId: INSTANCE_ID,
    timestamp: new Date().toISOString(),
  });
});

app.get("/metrics", async (req, res) => {
  try {
    res.setHeader("Content-Type", register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    res.status(500).send(error.message);
  }
});

// Create HTTP server and WebSocket server
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/**
 * Handle new WebSocket connections
 */
wss.on("connection", async (ws, req) => {
  let roomId = null;
  let clientId = null;

  try {
    // Parse query parameters
    const url = new URL(req.url, `ws://${req.headers.host}`);
    roomId = url.searchParams.get("room");
    clientId = url.searchParams.get("clientId") || uuidv4();

    if (!roomId) {
      ws.close(1008, "room parameter is required");
      return;
    }

    console.log(`[WS] Client ${clientId} joining room: ${roomId}`);

    // Get or create room
    const room = await roomManager.ensureRoom(roomId);
    roomManager.addClient(roomId, ws);
    connectedClients.set(roomManager.getTotalClients());

    // Send initial snapshot to client
    const state = Y.encodeStateAsUpdate(room.doc);
    const snapshot = {
      type: "sync",
      action: "snapshot",
      update: Buffer.from(state).toString("base64"),
    };
    ws.send(JSON.stringify(snapshot));
    messagesSent.inc();

    console.log(`[WS] Sent snapshot to client ${clientId} in room ${roomId}`);

    /**
     * Handle incoming messages from client
     */
    ws.on("message", async (raw) => {
      try {
        const msg =
          typeof raw === "string" ? JSON.parse(raw) : JSON.parse(raw.toString());

        if (msg.type === "update" && msg.update) {
          const updateBuf = Buffer.from(msg.update, "base64");

          // Apply update locally
          Y.applyUpdate(room.doc, updateBuf);
          updatesTotal.inc();

          console.log(
            `[WS] Applied update from client ${clientId} in room ${roomId}`
          );

          // Broadcast to other local clients (except sender)
          for (const client of room.clients) {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              const broadcast = {
                type: "sync",
                action: "update",
                update: msg.update,
                originInstance: INSTANCE_ID,
              };
              client.send(JSON.stringify(broadcast));
              messagesSent.inc();
            }
          }

          // Publish to Redis for other instances
          const redisPayload = {
            instanceId: INSTANCE_ID,
            room: roomId,
            update: msg.update,
          };
          await redisPub.publish(`room:${roomId}`, JSON.stringify(redisPayload));

          // Persist updated state (debounced in production)
          await roomManager.persistRoom(roomId);
        }
      } catch (error) {
        console.error(`[WS] Error handling message: ${error.message}`);
      }
    });

    /**
     * Handle client disconnection
     */
    ws.on("close", () => {
      console.log(`[WS] Client ${clientId} disconnected from room ${roomId}`);
      roomManager.removeClient(roomId, ws);
      connectedClients.set(roomManager.getTotalClients());
    });

    /**
     * Handle errors
     */
    ws.on("error", (error) => {
      console.error(`[WS] WebSocket error: ${error.message}`);
    });
  } catch (error) {
    console.error(`[WS] Connection error: ${error.message}`);
    ws.close(1011, "Internal server error");
  }
});

/**
 * Subscribe to Redis pub/sub for cross-instance updates
 */
redisSub.psubscribe("room:*", (err, count) => {
  if (err) {
    console.error(`[Redis] Subscribe error: ${err.message}`);
  } else {
    console.log(`[Redis] Subscribed to ${count} patterns`);
  }
});

redisSub.on("pmessage", async (pattern, channel, message) => {
  try {
    const msg = JSON.parse(message);

    // Ignore messages from this instance
    if (msg.instanceId === INSTANCE_ID) {
      return;
    }

    const roomId = msg.room;
    const updateB64 = msg.update;

    console.log(
      `[Redis] Received update for room ${roomId} from instance ${msg.instanceId}`
    );

    // Get or create room
    const room = await roomManager.ensureRoom(roomId);

    // Apply update
    const updateBuf = Buffer.from(updateB64, "base64");
    Y.applyUpdate(room.doc, updateBuf);
    updatesTotal.inc();

    // Broadcast to all local clients
    for (const client of room.clients) {
      if (client.readyState === WebSocket.OPEN) {
        const broadcast = {
          type: "sync",
          action: "update",
          update: updateB64,
          originInstance: msg.instanceId,
        };
        client.send(JSON.stringify(broadcast));
        messagesSent.inc();
      }
    }

    // Persist updated state
    await roomManager.persistRoom(roomId);
  } catch (error) {
    console.error(`[Redis] Error processing message: ${error.message}`);
  }
});

/**
 * Graceful shutdown
 */
process.on("SIGTERM", async () => {
  console.log("[Server] SIGTERM received, shutting down gracefully");
  
  // Persist all rooms
  for (const [roomId] of roomManager.rooms) {
    await roomManager.persistRoom(roomId);
  }
  
  wss.close(() => {
    server.close(() => {
      redisPub.disconnect();
      redisSub.disconnect();
      process.exit(0);
    });
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`[Server] Listening on port ${PORT}`);
  console.log(`[Server] Health: http://localhost:${PORT}/health`);
  console.log(`[Server] Metrics: http://localhost:${PORT}/metrics`);
  console.log(`[Server] Demo client: http://localhost:${PORT}/client.html`);
});
