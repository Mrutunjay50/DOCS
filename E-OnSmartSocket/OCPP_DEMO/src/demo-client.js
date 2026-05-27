const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

class OCPPDemoClient {
  constructor(serverUrl = 'ws://localhost:8081', chargePointId = 'DEMO_CP_001') {
    this.serverUrl = serverUrl;
    this.chargePointId = chargePointId;
    this.ws = null;
    this.connected = false;
    this.heartbeatInterval = null;
    this.statusUpdateInterval = null;
    this.currentTransaction = null;
    this.meterValue = 0;
    this.connectorStatus = 'Available';
  }

  connect() {
    console.log(`Connecting to OCPP server at ${this.serverUrl}...`);
    
    this.ws = new WebSocket(this.serverUrl);
    
    this.ws.on('open', () => {
      console.log('Connected to OCPP server');
      this.connected = true;
      this.sendBootNotification();
      this.startHeartbeat();
      this.startStatusUpdates();
    });

    this.ws.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        this.handleMessage(message);
      } catch (error) {
        console.error('Error parsing message:', error);
      }
    });

    this.ws.on('close', () => {
      console.log('Disconnected from OCPP server');
      this.connected = false;
      this.stopHeartbeat();
      this.stopStatusUpdates();
      
      // Attempt to reconnect after 5 seconds
      setTimeout(() => {
        console.log('Attempting to reconnect...');
        this.connect();
      }, 5000);
    });

    this.ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });
  }

  sendBootNotification() {
    const payload = {
      chargePointVendor: 'Demo Vendor',
      chargePointModel: 'Demo Model',
      chargePointSerialNumber: this.chargePointId,
      chargeBoxSerialNumber: this.chargePointId,
      firmwareVersion: '1.0.0'
    };

    this.sendMessage('BootNotification', payload);
  }

  sendStatusNotification(connectorId = 1, status = 'Available', errorCode = 'NoError') {
    const payload = {
      connectorId,
      errorCode,
      status,
      info: `Demo status update for connector ${connectorId}`,
      timestamp: new Date().toISOString(),
      vendorId: 'Demo Vendor',
      vendorErrorCode: 'NoError'
    };

    this.sendMessage('StatusNotification', payload);
    this.connectorStatus = status;
  }

  sendStartTransaction(connectorId = 1, idTag = 'DEMO_TAG') {
    if (this.currentTransaction) {
      console.log('Transaction already in progress');
      return;
    }

    const payload = {
      connectorId,
      idTag,
      meterStart: this.meterValue,
      timestamp: new Date().toISOString()
    };

    this.sendMessage('StartTransaction', payload);
    this.connectorStatus = 'Charging';
    this.sendStatusNotification(connectorId, 'Charging');
  }

  sendStopTransaction(transactionId, reason = 'Local') {
    if (!this.currentTransaction) {
      console.log('No transaction in progress');
      return;
    }

    const payload = {
      transactionId,
      timestamp: new Date().toISOString(),
      meterStop: this.meterValue,
      reason
    };

    this.sendMessage('StopTransaction', payload);
    this.currentTransaction = null;
    this.connectorStatus = 'Available';
    this.sendStatusNotification(1, 'Available');
  }

  sendMeterValues(connectorId = 1, transactionId = null) {
    const payload = {
      connectorId,
      transactionId,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [
            {
              value: this.meterValue.toString(),
              context: 'Sample.Periodic',
              format: 'Raw',
              measurand: 'Energy.Active.Import.Register',
              phase: 'L1',
              location: 'Outlet',
              unit: 'Wh'
            },
            {
              value: (this.meterValue * 0.23).toFixed(2), // Simulate cost
              context: 'Sample.Periodic',
              format: 'Raw',
              measurand: 'SoC',
              unit: '%'
            }
          ]
        }
      ]
    };

    this.sendMessage('MeterValues', payload);
  }

  sendHeartbeat() {
    this.sendMessage('Heartbeat', {});
  }

  sendAuthorize(idTag = 'DEMO_TAG') {
    const payload = {
      idTag
    };

    this.sendMessage('Authorize', payload);
  }

  sendDataTransfer(vendorId = 'Demo Vendor', messageId = 'Status', data = 'Demo data') {
    const payload = {
      vendorId,
      messageId,
      data
    };

    this.sendMessage('DataTransfer', payload);
  }

  handleMessage(message) {
    const [messageType, uniqueId, action, payload] = message;

    if (messageType === 3) { // CallResult
      console.log(`Received CallResult for ${action}:`, payload);
      this.handleCallResult(action, payload);
    } else if (messageType === 4) { // CallError
      console.log(`Received CallError for ${action}:`, payload);
    } else if (messageType === 2) { // Call
      console.log(`Received Call: ${action}`, payload);
      this.handleCall(action, uniqueId, payload);
    }
  }

  handleCallResult(action, payload) {
    switch (action) {
      case 'BootNotification':
        console.log('Boot notification accepted');
        break;
      case 'StartTransaction':
        this.currentTransaction = {
          id: payload.transactionId,
          startTime: new Date(),
          meterStart: this.meterValue
        };
        console.log(`Transaction started with ID: ${payload.transactionId}`);
        break;
      case 'StopTransaction':
        console.log('Transaction stopped');
        break;
      case 'Heartbeat':
        console.log('Heartbeat response received');
        break;
      case 'Authorize':
        console.log(`Authorization result: ${payload.idTagInfo.status}`);
        break;
      case 'DataTransfer':
        console.log(`Data transfer result: ${payload.status}`);
        break;
      case 'ChangeConfiguration':
        console.log(`Configuration change result: ${payload.status}`);
        break;
      case 'GetConfiguration':
        console.log('Configuration received:', payload.configurationKey);
        break;
      case 'RemoteStartTransaction':
        console.log(`Remote start transaction result: ${payload.status}`);
        if (payload.status === 'Accepted') {
          setTimeout(() => this.sendStartTransaction(), 1000);
        }
        break;
      case 'RemoteStopTransaction':
        console.log(`Remote stop transaction result: ${payload.status}`);
        if (payload.status === 'Accepted' && this.currentTransaction) {
          setTimeout(() => this.sendStopTransaction(this.currentTransaction.id), 1000);
        }
        break;
    }
  }

  handleCall(action, uniqueId, payload) {
    switch (action) {
      case 'RemoteStartTransaction':
        this.sendResponse(uniqueId, 'RemoteStartTransaction', { status: 'Accepted' });
        setTimeout(() => this.sendStartTransaction(payload.connectorId, payload.idTag), 1000);
        break;
      case 'RemoteStopTransaction':
        this.sendResponse(uniqueId, 'RemoteStopTransaction', { status: 'Accepted' });
        if (this.currentTransaction) {
          setTimeout(() => this.sendStopTransaction(payload.transactionId), 1000);
        }
        break;
      case 'ChangeConfiguration':
        this.sendResponse(uniqueId, 'ChangeConfiguration', { status: 'Accepted' });
        console.log(`Configuration changed: ${payload.key} = ${payload.value}`);
        break;
      case 'GetConfiguration':
        this.sendResponse(uniqueId, 'GetConfiguration', {
          configurationKey: [
            {
              key: payload.key,
              readonly: false,
              value: 'demo_value'
            }
          ],
          unknownKey: []
        });
        break;
      case 'Reset':
        this.sendResponse(uniqueId, 'Reset', { status: 'Accepted' });
        console.log('Reset command received');
        break;
      case 'UnlockConnector':
        this.sendResponse(uniqueId, 'UnlockConnector', { status: 'Unlocked' });
        console.log('Unlock connector command received');
        break;
      default:
        console.log(`Unhandled call: ${action}`);
        this.sendError(uniqueId, 'NotImplemented', `Action ${action} not implemented`);
    }
  }

  sendMessage(action, payload) {
    if (!this.connected) {
      console.log('Not connected to server');
      return;
    }

    const message = [2, uuidv4(), action, payload];
    this.ws.send(JSON.stringify(message));
    console.log(`Sent: ${action}`, payload);
  }

  sendResponse(uniqueId, action, payload) {
    if (!this.connected) {
      console.log('Not connected to server');
      return;
    }

    const message = [3, uniqueId, action, payload];
    this.ws.send(JSON.stringify(message));
    console.log(`Sent response: ${action}`, payload);
  }

  sendError(uniqueId, errorCode, errorDescription) {
    if (!this.connected) {
      console.log('Not connected to server');
      return;
    }

    const message = [4, uniqueId, errorCode, errorDescription, {}];
    this.ws.send(JSON.stringify(message));
    console.log(`Sent error: ${errorCode} - ${errorDescription}`);
  }

  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, 300000); // 5 minutes
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  startStatusUpdates() {
    this.statusUpdateInterval = setInterval(() => {
      // Simulate charging progress
      if (this.connectorStatus === 'Charging' && this.currentTransaction) {
        this.meterValue += Math.random() * 100; // Simulate energy consumption
        this.sendMeterValues(1, this.currentTransaction.id);
      }
    }, 10000); // Every 10 seconds
  }

  stopStatusUpdates() {
    if (this.statusUpdateInterval) {
      clearInterval(this.statusUpdateInterval);
      this.statusUpdateInterval = null;
    }
  }

  disconnect() {
    this.connected = false;
    this.stopHeartbeat();
    this.stopStatusUpdates();
    if (this.ws) {
      this.ws.close();
    }
  }

  // Demo methods for testing
  simulateCharging() {
    console.log('Starting charging simulation...');
    this.sendStartTransaction();
  }

  simulateStop() {
    console.log('Stopping charging simulation...');
    if (this.currentTransaction) {
      this.sendStopTransaction(this.currentTransaction.id);
    }
  }

  simulateFault() {
    console.log('Simulating fault...');
    this.sendStatusNotification(1, 'Faulted', 'InternalError');
  }

  simulateRecovery() {
    console.log('Simulating recovery...');
    this.sendStatusNotification(1, 'Available', 'NoError');
  }
}

// Demo client setup
const client = new OCPPDemoClient();

// Connect to server
client.connect();

// Handle process termination
process.on('SIGINT', () => {
  console.log('\nShutting down demo client...');
  client.disconnect();
  process.exit(0);
});

// Demo commands (uncomment to test)
setTimeout(() => {
  console.log('\n=== Demo Commands ===');
  console.log('Available methods:');
  console.log('- client.simulateCharging()');
  console.log('- client.simulateStop()');
  console.log('- client.simulateFault()');
  console.log('- client.simulateRecovery()');
  console.log('- client.sendAuthorize()');
  console.log('- client.sendDataTransfer()');
  console.log('\nDemo client is running. Use the web interface at http://localhost:8080 to control the charge point.');
}, 2000);

module.exports = OCPPDemoClient;


