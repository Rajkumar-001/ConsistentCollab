import * as Y from "yjs";
import { activeRooms } from "./metrics.js";

/**
 * RoomManager handles the lifecycle of collaboration rooms,
 * including document creation, persistence, and eviction.
 */
class RoomManager {
  constructor(redisClient) {
    this.rooms = new Map(); // roomId => { doc: Y.Doc, clients: Set<WebSocket> }
    this.redis = redisClient;
    this.evictionTimeout = 60000; // 60 seconds
    this.evictionTimers = new Map(); // roomId => timer
  }

  /**
   * Get or create a room, loading persisted state if available
   */
  async ensureRoom(roomId) {
    if (this.rooms.has(roomId)) {
      this.cancelEviction(roomId);
      return this.rooms.get(roomId);
    }

    const doc = new Y.Doc();
    const clients = new Set();

    // Try to load persisted snapshot from Redis
    const key = `room:${roomId}:state`;
    try {
      const snapshot = await this.redis.get(key);
      if (snapshot) {
        const buffer = Buffer.from(snapshot, "base64");
        Y.applyUpdate(doc, buffer);
        console.log(`[RoomManager] Loaded persisted state for room: ${roomId}`);
      }
    } catch (error) {
      console.error(`[RoomManager] Error loading room state: ${error.message}`);
    }

    const room = { doc, clients };
    this.rooms.set(roomId, room);
    activeRooms.set(this.rooms.size);

    return room;
  }

  /**
   * Add a client to a room
   */
  addClient(roomId, ws) {
    const room = this.rooms.get(roomId);
    if (room) {
      room.clients.add(ws);
      this.cancelEviction(roomId);
    }
  }

  /**
   * Remove a client from a room and schedule eviction if empty
   */
  removeClient(roomId, ws) {
    const room = this.rooms.get(roomId);
    if (room) {
      room.clients.delete(ws);
      
      // Schedule eviction if no clients remain
      if (room.clients.size === 0) {
        this.scheduleEviction(roomId);
      }
    }
  }

  /**
   * Persist room state to Redis
   */
  async persistRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    try {
      const state = Y.encodeStateAsUpdate(room.doc);
      const key = `room:${roomId}:state`;
      await this.redis.set(key, Buffer.from(state).toString("base64"));
    } catch (error) {
      console.error(`[RoomManager] Error persisting room: ${error.message}`);
    }
  }

  /**
   * Schedule room eviction after timeout
   */
  scheduleEviction(roomId) {
    this.cancelEviction(roomId);
    
    const timer = setTimeout(async () => {
      const room = this.rooms.get(roomId);
      if (room && room.clients.size === 0) {
        console.log(`[RoomManager] Evicting room: ${roomId}`);
        await this.persistRoom(roomId);
        this.rooms.delete(roomId);
        this.evictionTimers.delete(roomId);
        activeRooms.set(this.rooms.size);
      }
    }, this.evictionTimeout);

    this.evictionTimers.set(roomId, timer);
  }

  /**
   * Cancel scheduled eviction
   */
  cancelEviction(roomId) {
    const timer = this.evictionTimers.get(roomId);
    if (timer) {
      clearTimeout(timer);
      this.evictionTimers.delete(roomId);
    }
  }

  /**
   * Get room if it exists
   */
  getRoom(roomId) {
    return this.rooms.get(roomId);
  }

  /**
   * Get total number of connected clients across all rooms
   */
  getTotalClients() {
    let total = 0;
    for (const room of this.rooms.values()) {
      total += room.clients.size;
    }
    return total;
  }
}

export default RoomManager;
