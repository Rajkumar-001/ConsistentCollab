import client from "prom-client";

// Create a registry for all metrics
const register = new client.Registry();

// Define metrics
const activeRooms = new client.Gauge({
  name: "collab_active_rooms",
  help: "Number of active collaboration rooms",
  registers: [register],
});

const connectedClients = new client.Gauge({
  name: "collab_connected_clients",
  help: "Number of connected WebSocket clients",
  registers: [register],
});

const updatesTotal = new client.Counter({
  name: "collab_updates_total",
  help: "Total number of document updates processed",
  registers: [register],
});

const messagesSent = new client.Counter({
  name: "collab_messages_sent_total",
  help: "Total number of messages sent to clients",
  registers: [register],
});

export { register, activeRooms, connectedClients, updatesTotal, messagesSent };
