# ConsistentCollab

A distributed state synchronization service for real-time collaboration using CRDTs (Yjs), WebSocket, and Redis pub/sub.

## Features

- **Real-time Collaboration**: Multiple clients can edit a shared JSON document simultaneously
- **Conflict-Free Updates**: Uses Yjs CRDT for deterministic conflict resolution
- **Multi-Instance Support**: Horizontal scaling with Redis pub/sub for cross-instance synchronization
- **Persistence**: Room state persisted to Redis for recovery after restarts
- **Observability**: Prometheus-compatible metrics endpoint
- **Auto-Eviction**: Empty rooms are automatically cleaned up after timeout

## Architecture

### High-Level Overview

```
┌─────────────────┐       WebSocket        ┌─────────────────┐
│ Browser Client  │ <──────────────────> │ Backend Instance│
│ (Yjs + WS)      │                       │  (Node.js + WS) │
└─────────────────┘                       └─────────────────┘
      │                                           │
      │                                           │ Redis Pub/Sub
      │                                           ▼
┌─────────────────┐                       ┌─────────────────┐
│ Browser Client  │ <──────────────────> │ Backend Instance│
│ (Yjs + WS)      │                       │  (Node.js + WS) │
└─────────────────┘                       └─────────────────┘
                                                  │
                                                  ▼
                                          ┌─────────────────┐
                                          │ Redis           │
                                          │ (pub/sub + KV)  │
                                          └─────────────────┘
```

### Key Components

1. **Client**: HTML/JS with Yjs CRDT library for local document state
2. **Backend Server**: Node.js WebSocket server with Yjs document per room
3. **Redis Pub/Sub**: Cross-instance message propagation (channel: `room:{roomId}`)
4. **Redis KV**: Persistence layer for room snapshots (key: `room:{roomId}:state`)
5. **Metrics**: Prometheus-compatible `/metrics` endpoint

### Conflict Resolution

We use **Yjs CRDT** (Conflict-free Replicated Data Type) which ensures:

- **No Data Loss**: All concurrent edits are preserved
- **Deterministic Merging**: Same inputs always produce the same output
- **Causal Ordering**: Operations maintain causality through unique identifiers
- **Last-Writer-Wins**: For simple key assignments, uses Lamport-like clocks with client ID tie-breaking

When two clients update the same field simultaneously, Yjs applies operation-based CRDT rules to merge changes deterministically without requiring coordination.

## Quick Start

### Prerequisites

- **Docker & Docker Compose** (recommended), or
- **Node.js >= 18** + **Redis**

### Option 1: Docker (Recommended)

```bash
# Clone repository
git clone https://github.com/Rajkumar-001/ConsistentCollab.git
cd ConsistentCollab

# Start all services (2 instances + Redis)
docker-compose up --build

# Services will be available at:
# - Instance 1: http://localhost:1234
# - Instance 2: http://localhost:1235
# - Redis: localhost:6379
```

### Option 2: Local Development

```bash
# Install dependencies
npm ci

# Start Redis (in separate terminal)
redis-server

# Start first instance
REDIS_URL=redis://localhost:6379 INSTANCE_ID=inst-1 PORT=1234 npm start

# Start second instance (in separate terminal)
REDIS_URL=redis://localhost:6379 INSTANCE_ID=inst-2 PORT=1235 npm start
```

## Testing the System

### 1. Open Demo Clients

Open multiple browser tabs:

- **Client A (Instance 1)**: http://localhost:1234/client.html?room=demo
- **Client B (Instance 2)**: http://localhost:1235/client.html?room=demo

### 2. Test Real-Time Sync

1. Type in Client A's textarea
2. Observe the update appearing in Client B
3. Type in Client B's textarea
4. Observe the update appearing in Client A

Both clients connected to different backend instances will see consistent updates in real-time.

### 3. Test Persistence

1. Edit the document in any client
2. Stop all backend instances: `docker-compose down` (or Ctrl+C)
3. Restart: `docker-compose up`
4. Open a new client: http://localhost:1234/client.html?room=demo
5. Verify the previous state is restored from Redis

### 4. View Metrics

Open in browser:
- http://localhost:1234/metrics
- http://localhost:1235/metrics

**Available Metrics:**
- `collab_active_rooms` - Number of active rooms
- `collab_connected_clients` - Number of connected WebSocket clients
- `collab_updates_total` - Total document updates processed
- `collab_messages_sent_total` - Total messages sent to clients

### 5. Health Checks

- http://localhost:1234/health
- http://localhost:1235/health

Returns instance ID and timestamp.

## Project Structure

```
ConsistentCollab/
├── src/
│   ├── server.js           # Main WebSocket server + Redis integration
│   ├── roomManager.js      # Room lifecycle, persistence, eviction
│   ├── metrics.js          # Prometheus metrics definitions
│   └── clientDemo/
│       └── client.html     # Demo client with Yjs integration
├── docker-compose.yml      # Multi-instance + Redis setup
├── Dockerfile              # Container image
├── package.json            # Dependencies
└── README.md
```

## API Reference

### WebSocket Protocol

**Connect:**
```
ws://host:port/?room=ROOM_ID&clientId=CLIENT_ID
```

**Client → Server (Update):**
```json
{
  "type": "update",
  "room": "roomA",
  "clientId": "uuid",
  "update": "<base64-encoded-yjs-update>"
}
```

**Server → Client (Snapshot on Join):**
```json
{
  "type": "sync",
  "action": "snapshot",
  "update": "<base64-encoded-yjs-state>"
}
```

**Server → Client (Incremental Update):**
```json
{
  "type": "sync",
  "action": "update",
  "update": "<base64-encoded-yjs-update>",
  "originInstance": "inst-1"
}
```

### HTTP Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check (returns instance ID) |
| `/metrics` | GET | Prometheus metrics |
| `/client.html` | GET | Demo client interface |

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `1234` | HTTP/WebSocket server port |
| `INSTANCE_ID` | `uuid()` | Unique instance identifier |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |

## Testing Scenarios

### Functional Tests

1. **Client Join**: Client receives current document snapshot
2. **Update Broadcast**: Updates sent to all clients in the same room
3. **Cross-Instance Sync**: Clients on different instances see updates
4. **Concurrent Edits**: Two clients editing simultaneously merge correctly
5. **Persistence**: Restarted instance recovers room state from Redis

### Load Testing (Example)

```bash
# Using wscat or custom script
for i in {1..100}; do
  wscat -c "ws://localhost:1234/?room=load-test&clientId=client-$i" &
done
```

Monitor metrics at http://localhost:1234/metrics

### Edge Cases

- **Large Updates**: Server handles updates up to WebSocket frame limits
- **Network Partitions**: Redis pub/sub reconnects automatically
- **Message Loss**: Yjs updates are idempotent; state converges on reconnect

## Production Considerations

For production deployment, consider:

1. **Authentication**: Add JWT validation for WebSocket connections
2. **Authorization**: Implement per-room access control (ACLs)
3. **Rate Limiting**: Throttle updates per client/room
4. **Binary Frames**: Use binary WebSocket frames for efficiency
5. **Compression**: Enable WebSocket compression
6. **Durability**: Use Redis Streams or PostgreSQL for stronger persistence
7. **Monitoring**: Integrate with Prometheus + Grafana
8. **TLS**: Enable WSS and HTTPS
9. **Horizontal Scaling**: Deploy behind load balancer with sticky sessions
10. **Graceful Shutdown**: Flush all room state before terminating

## Troubleshooting

**Clients can't connect:**
- Check WebSocket port is accessible
- Verify `room` parameter is provided
- Check browser console for errors

**Updates not syncing:**
- Verify Redis is running and accessible
- Check instance logs for Redis connection errors
- Ensure both instances use same `REDIS_URL`

**High memory usage:**
- Reduce room eviction timeout (default: 60s)
- Implement room size limits
- Monitor metrics for active rooms count

## License

MIT

## Author

Backend + Infrastructure Engineer Candidate for VideoSDK
