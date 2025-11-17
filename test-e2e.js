import WebSocket from 'ws';
import * as Y from 'yjs';

console.log('=== Starting End-to-End Test ===\n');

// Test configuration
const ROOM = 'test-room';
const INSTANCE_1_URL = 'ws://localhost:1234';
const INSTANCE_2_URL = 'ws://localhost:1235';

let client1, client2, client3;
let ydoc1, ydoc2, ydoc3;
let ytext1, ytext2, ytext3;

let testResults = {
  passed: 0,
  failed: 0,
  tests: []
};

function logTest(name, passed, details = '') {
  const status = passed ? '✓ PASS' : '✗ FAIL';
  console.log(`${status}: ${name}`);
  if (details) console.log(`   ${details}`);
  
  testResults.tests.push({ name, passed, details });
  if (passed) testResults.passed++;
  else testResults.failed++;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Cleanup function
async function cleanup() {
  console.log('\n--- Cleaning up ---');
  if (client1) client1.close();
  if (client2) client2.close();
  if (client3) client3.close();
  await sleep(500);
}

// Test 1: Client connects and receives snapshot
async function test1_ClientConnectsAndReceivesSnapshot() {
  console.log('\n--- Test 1: Client connects and receives snapshot ---');
  
  return new Promise((resolve) => {
    ydoc1 = new Y.Doc();
    ytext1 = ydoc1.getText('shared');
    
    let receivedSnapshot = false;
    
    client1 = new WebSocket(`${INSTANCE_1_URL}/?room=${ROOM}&clientId=client-1`);
    
    client1.on('open', () => {
      console.log('Client 1 connected to instance 1');
    });
    
    client1.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      console.log('Client 1 received message:', msg.type, msg.action);
      
      if (msg.type === 'sync' && msg.action === 'snapshot') {
        receivedSnapshot = true;
        const updateArray = Uint8Array.from(atob(msg.update), c => c.charCodeAt(0));
        Y.applyUpdate(ydoc1, updateArray);
        
        logTest('Client receives snapshot on connect', true, 'Snapshot received successfully');
        resolve();
      }
    });
    
    setTimeout(() => {
      if (!receivedSnapshot) {
        logTest('Client receives snapshot on connect', false, 'No snapshot received within timeout');
        resolve();
      }
    }, 3000);
  });
}

// Test 2: Client sends update and it's applied locally
async function test2_ClientSendsUpdate() {
  console.log('\n--- Test 2: Client sends update ---');
  
  return new Promise((resolve) => {
    // Update the document
    ydoc1.transact(() => {
      ytext1.insert(0, 'Hello World');
    });
    
    console.log('Client 1 document state:', ytext1.toString());
    
    const update = Y.encodeStateAsUpdate(ydoc1);
    const updateBase64 = btoa(String.fromCharCode(...new Uint8Array(update)));
    
    const message = {
      type: 'update',
      room: ROOM,
      clientId: 'client-1',
      update: updateBase64
    };
    
    client1.send(JSON.stringify(message));
    console.log('Client 1 sent update to server');
    
    logTest('Client sends update', true, `Document state: "${ytext1.toString()}"`);
    
    setTimeout(resolve, 1000);
  });
}

// Test 3: Second client on same instance receives update
async function test3_SecondClientReceivesUpdate() {
  console.log('\n--- Test 3: Second client on same instance receives update ---');
  
  return new Promise((resolve) => {
    ydoc2 = new Y.Doc();
    ytext2 = ydoc2.getText('shared');
    
    let receivedSnapshot = false;
    let receivedUpdate = false;
    
    client2 = new WebSocket(`${INSTANCE_1_URL}/?room=${ROOM}&clientId=client-2`);
    
    client2.on('open', () => {
      console.log('Client 2 connected to instance 1 (same as client 1)');
    });
    
    client2.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      console.log('Client 2 received message:', msg.type, msg.action);
      
      const updateArray = Uint8Array.from(atob(msg.update), c => c.charCodeAt(0));
      Y.applyUpdate(ydoc2, updateArray);
      
      if (msg.type === 'sync' && msg.action === 'snapshot') {
        receivedSnapshot = true;
        console.log('Client 2 document state after snapshot:', ytext2.toString());
      }
      
      if (msg.type === 'sync' && msg.action === 'update') {
        receivedUpdate = true;
        console.log('Client 2 document state after update:', ytext2.toString());
      }
    });
    
    setTimeout(() => {
      const docState = ytext2.toString();
      const expectedState = 'Hello World';
      const passed = docState === expectedState;
      
      logTest(
        'Second client receives update',
        passed,
        passed 
          ? `Client 2 document: "${docState}"` 
          : `Expected "${expectedState}", got "${docState}"`
      );
      
      resolve();
    }, 2000);
  });
}

// Test 4: Third client on different instance receives update
async function test4_ThirdClientOnDifferentInstanceReceivesUpdate() {
  console.log('\n--- Test 4: Third client on different instance receives update ---');
  
  return new Promise((resolve) => {
    ydoc3 = new Y.Doc();
    ytext3 = ydoc3.getText('shared');
    
    client3 = new WebSocket(`${INSTANCE_2_URL}/?room=${ROOM}&clientId=client-3`);
    
    client3.on('open', () => {
      console.log('Client 3 connected to instance 2 (different from clients 1 & 2)');
    });
    
    client3.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      console.log('Client 3 received message:', msg.type, msg.action, msg.originInstance || '');
      
      const updateArray = Uint8Array.from(atob(msg.update), c => c.charCodeAt(0));
      Y.applyUpdate(ydoc3, updateArray);
      
      if (msg.type === 'sync' && msg.action === 'snapshot') {
        console.log('Client 3 document state after snapshot:', ytext3.toString());
      }
      
      if (msg.type === 'sync' && msg.action === 'update') {
        console.log('Client 3 document state after update:', ytext3.toString());
      }
    });
    
    setTimeout(() => {
      const docState = ytext3.toString();
      const expectedState = 'Hello World';
      const passed = docState === expectedState;
      
      logTest(
        'Third client on different instance receives update (cross-instance sync)',
        passed,
        passed 
          ? `Client 3 document: "${docState}"` 
          : `Expected "${expectedState}", got "${docState}"`
      );
      
      resolve();
    }, 2000);
  });
}

// Test 5: Concurrent updates from different clients
async function test5_ConcurrentUpdates() {
  console.log('\n--- Test 5: Concurrent updates from different clients ---');
  
  return new Promise((resolve) => {
    let client1ReceivedCount = 0;
    let client2ReceivedCount = 0;
    
    // Set up listeners to apply incoming updates
    const originalClient1Handler = client1.listeners('message')[0];
    const originalClient2Handler = client2.listeners('message')[0];
    
    // Remove original handlers
    client1.removeAllListeners('message');
    client2.removeAllListeners('message');
    
    // Add new handlers that apply updates
    client1.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      console.log('Client 1 received message:', msg.type, msg.action);
      
      if (msg.type === 'sync' && msg.action === 'update') {
        client1ReceivedCount++;
        const updateArray = Uint8Array.from(atob(msg.update), c => c.charCodeAt(0));
        Y.applyUpdate(ydoc1, updateArray);
        console.log('  Client 1 applied update, new state:', ytext1.toString());
      }
    });
    
    client2.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      console.log('Client 2 received message:', msg.type, msg.action);
      
      if (msg.type === 'sync' && msg.action === 'update') {
        client2ReceivedCount++;
        const updateArray = Uint8Array.from(atob(msg.update), c => c.charCodeAt(0));
        Y.applyUpdate(ydoc2, updateArray);
        console.log('  Client 2 applied update, new state:', ytext2.toString());
      }
    });
    
    // Client 1 adds text
    ydoc1.transact(() => {
      ytext1.insert(ytext1.length, ' from client1');
    });
    const update1 = Y.encodeStateAsUpdate(ydoc1);
    client1.send(JSON.stringify({
      type: 'update',
      room: ROOM,
      clientId: 'client-1',
      update: btoa(String.fromCharCode(...new Uint8Array(update1)))
    }));
    console.log('Client 1 sent update:', ytext1.toString());
    
    // Client 2 adds text (after receiving client1's update)
    setTimeout(() => {
      ydoc2.transact(() => {
        ytext2.insert(ytext2.length, ' from client2');
      });
      const update2 = Y.encodeStateAsUpdate(ydoc2);
      client2.send(JSON.stringify({
        type: 'update',
        room: ROOM,
        clientId: 'client-2',
        update: btoa(String.fromCharCode(...new Uint8Array(update2)))
      }));
      console.log('Client 2 sent update:', ytext2.toString());
    }, 500);
    
    // Wait for updates to propagate
    setTimeout(() => {
      console.log('Final states:');
      console.log('  Client 1:', ytext1.toString());
      console.log('  Client 2:', ytext2.toString());
      console.log('  Client 3:', ytext3.toString());
      
      // All clients should have both updates (order may vary due to CRDT)
      const state1 = ytext1.toString();
      const state2 = ytext2.toString();
      const state3 = ytext3.toString();
      
      const allStatesEqual = state1 === state2 && state2 === state3;
      const containsBothUpdates = state1.includes('client1') && state1.includes('client2');
      
      const passed = allStatesEqual && containsBothUpdates;
      
      logTest(
        'Concurrent updates resolve correctly (CRDT conflict resolution)',
        passed,
        passed
          ? `All clients converged to: "${state1}"`
          : `States differ - C1: "${state1}", C2: "${state2}", C3: "${state3}"`
      );
      
      resolve();
    }, 3000);
  });
}

// Test 6: Metrics endpoint
async function test6_MetricsEndpoint() {
  console.log('\n--- Test 6: Metrics endpoint ---');
  
  try {
    const response = await fetch('http://localhost:1234/metrics');
    const metrics = await response.text();
    
    const hasActiveRooms = metrics.includes('collab_active_rooms');
    const hasConnectedClients = metrics.includes('collab_connected_clients');
    const hasUpdates = metrics.includes('collab_updates_total');
    const hasMessages = metrics.includes('collab_messages_sent_total');
    
    const passed = hasActiveRooms && hasConnectedClients && hasUpdates && hasMessages;
    
    logTest(
      'Metrics endpoint exposes required metrics',
      passed,
      passed 
        ? 'All required metrics present'
        : 'Some metrics missing'
    );
    
    if (passed) {
      console.log('Metrics preview:');
      metrics.split('\n').filter(line => 
        line.startsWith('collab_') && !line.startsWith('#')
      ).forEach(line => console.log('  ' + line));
    }
  } catch (error) {
    logTest('Metrics endpoint exposes required metrics', false, error.message);
  }
}

// Test 7: Persistence - restart and recover
async function test7_Persistence() {
  console.log('\n--- Test 7: Persistence (checking Redis state) ---');
  
  await sleep(2000); // Let updates persist
  
  try {
    // Check if room state exists in Redis
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    
    const { stdout } = await execAsync(`redis-cli GET "room:${ROOM}:state"`);
    const hasState = stdout.trim().length > 10;
    
    logTest(
      'Room state persisted to Redis',
      hasState,
      hasState ? 'State found in Redis' : 'No state found in Redis'
    );
  } catch (error) {
    logTest('Room state persisted to Redis', false, error.message);
  }
}

// Main test runner
async function runTests() {
  try {
    // Clear Redis before starting
    console.log('Clearing Redis state...');
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    await execAsync('redis-cli FLUSHALL');
    await sleep(500);
    console.log('Redis cleared\n');
    
    await test1_ClientConnectsAndReceivesSnapshot();
    await test2_ClientSendsUpdate();
    await test3_SecondClientReceivesUpdate();
    await test4_ThirdClientOnDifferentInstanceReceivesUpdate();
    await test5_ConcurrentUpdates();
    await test6_MetricsEndpoint();
    await test7_Persistence();
    
    await cleanup();
    
    // Print summary
    console.log('\n=================================');
    console.log('       TEST SUMMARY');
    console.log('=================================');
    console.log(`Total Tests: ${testResults.tests.length}`);
    console.log(`Passed: ${testResults.passed} ✓`);
    console.log(`Failed: ${testResults.failed} ✗`);
    console.log('=================================\n');
    
    if (testResults.failed > 0) {
      console.log('Failed tests:');
      testResults.tests.filter(t => !t.passed).forEach(t => {
        console.log(`  - ${t.name}: ${t.details}`);
      });
    }
    
    process.exit(testResults.failed > 0 ? 1 : 0);
  } catch (error) {
    console.error('Test runner error:', error);
    await cleanup();
    process.exit(1);
  }
}

// Run tests
runTests();
