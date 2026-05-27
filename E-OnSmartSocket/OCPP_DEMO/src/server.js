const WebSocket = require('ws');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

class OCPPCentralServer {
  constructor(port = 8080) {
    this.port = port;
    this.chargePoints = new Map();
    this.messageHandlers = new Map();
    this.setupMessageHandlers();
    this.setupWebServer();
    this.setupWebSocketServer();
  }

  setupWebServer() {
    this.app = express();
    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, '../public')));

    // API endpoints
    this.app.get('/api/chargepoints', (req, res) => {
      const chargePoints = Array.from(this.chargePoints.values()).map(cp => ({
        id: cp.id,
        status: cp.status,
        lastSeen: cp.lastSeen,
        vendor: cp.vendor,
        model: cp.model,
        serialNumber: cp.serialNumber,
        firmwareVersion: cp.firmwareVersion
      }));
      res.json(chargePoints);
    });

    this.app.post('/api/chargepoints/:id/remote-start', (req, res) => {
      const chargePoint = this.chargePoints.get(req.params.id);
      if (!chargePoint) {
        return res.status(404).json({ error: 'Charge point not found' });
      }

      const { connectorId = 1, idTag = 'DEMO_TAG' } = req.body;
      this.sendMessage(chargePoint.ws, 'RemoteStartTransaction', {
        connectorId,
        idTag
      });

      res.json({ message: 'Remote start transaction sent' });
    });

    this.app.post('/api/chargepoints/:id/remote-stop', (req, res) => {
      const chargePoint = this.chargePoints.get(req.params.id);
      if (!chargePoint) {
        return res.status(404).json({ error: 'Charge point not found' });
      }

      const { transactionId } = req.body;
      this.sendMessage(chargePoint.ws, 'RemoteStopTransaction', {
        transactionId
      });

      res.json({ message: 'Remote stop transaction sent' });
    });

    this.app.post('/api/chargepoints/:id/change-configuration', (req, res) => {
      const chargePoint = this.chargePoints.get(req.params.id);
      if (!chargePoint) {
        return res.status(404).json({ error: 'Charge point not found' });
      }

      const { key, value } = req.body;
      this.sendMessage(chargePoint.ws, 'ChangeConfiguration', {
        key,
        value
      });

      res.json({ message: 'Change configuration sent' });
    });

    this.app.listen(this.port, () => {
      console.log(`Web server running on http://localhost:${this.port}`);
    });
  }

  setupWebSocketServer() {
    this.wss = new WebSocket.Server({ port: 8081 });
    console.log(`OCPP WebSocket server running on ws://localhost:8081`);

    this.wss.on('connection', (ws, req) => {
      console.log('New WebSocket connection established');
      
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data);
          this.handleMessage(ws, message);
        } catch (error) {
          console.error('Error parsing message:', error);
          this.sendError(ws, 'FormationViolation', 'Invalid JSON format');
        }
      });

      ws.on('close', () => {
        console.log('WebSocket connection closed');
        // Remove charge point from registry
        for (const [id, cp] of this.chargePoints.entries()) {
          if (cp.ws === ws) {
            this.chargePoints.delete(id);
            console.log(`Charge point ${id} disconnected`);
            break;
          }
        }
      });

      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
      });
    });
  }

  setupMessageHandlers() {
    this.messageHandlers.set('BootNotification', this.handleBootNotification.bind(this));
    this.messageHandlers.set('StatusNotification', this.handleStatusNotification.bind(this));
    this.messageHandlers.set('StartTransaction', this.handleStartTransaction.bind(this));
    this.messageHandlers.set('StopTransaction', this.handleStopTransaction.bind(this));
    this.messageHandlers.set('MeterValues', this.handleMeterValues.bind(this));
    this.messageHandlers.set('Heartbeat', this.handleHeartbeat.bind(this));
    this.messageHandlers.set('Authorize', this.handleAuthorize.bind(this));
    this.messageHandlers.set('DataTransfer', this.handleDataTransfer.bind(this));
    this.messageHandlers.set('ChangeConfiguration', this.handleChangeConfiguration.bind(this));
    this.messageHandlers.set('GetConfiguration', this.handleGetConfiguration.bind(this));
    this.messageHandlers.set('RemoteStartTransaction', this.handleRemoteStartTransaction.bind(this));
    this.messageHandlers.set('RemoteStopTransaction', this.handleRemoteStopTransaction.bind(this));
  }

  handleMessage(ws, message) {
    const [messageType, uniqueId, action, payload] = message;
    
    if (messageType !== 2) {
      console.log(`Received ${messageType} message: ${action}`);
      return;
    }

    console.log(`Received Call message: ${action}`, payload);

    const handler = this.messageHandlers.get(action);
    if (handler) {
      handler(ws, uniqueId, payload);
    } else {
      console.log(`No handler for action: ${action}`);
      this.sendError(ws, 'NotImplemented', `Action ${action} not implemented`);
    }
  }

  handleBootNotification(ws, uniqueId, payload) {
    const { chargePointVendor, chargePointModel, chargePointSerialNumber, chargeBoxSerialNumber, firmwareVersion } = payload;
    
    const chargePointId = chargeBoxSerialNumber || chargePointSerialNumber || 'UNKNOWN';
    
    this.chargePoints.set(chargePointId, {
      id: chargePointId,
      ws: ws,
      vendor: chargePointVendor,
      model: chargePointModel,
      serialNumber: chargePointSerialNumber,
      firmwareVersion: firmwareVersion,
      status: 'Available',
      lastSeen: new Date(),
      currentTransaction: null
    });

    console.log(`Charge point ${chargePointId} booted: ${chargePointVendor} ${chargePointModel}`);

    this.sendResponse(ws, uniqueId, 'BootNotification', {
      status: 'Accepted',
      currentTime: new Date().toISOString(),
      interval: 300 // 5 minutes
    });
  }

  handleStatusNotification(ws, uniqueId, payload) {
    const { connectorId, errorCode, status, info } = payload;
    
    // Find the charge point
    let chargePoint = null;
    for (const [id, cp] of this.chargePoints.entries()) {
      if (cp.ws === ws) {
        chargePoint = cp;
        break;
      }
    }

    if (chargePoint) {
      chargePoint.status = status;
      chargePoint.lastSeen = new Date();
      chargePoint.errorCode = errorCode;
      chargePoint.info = info;
      
      console.log(`Charge point ${chargePoint.id} status: ${status} (connector ${connectorId})`);
    }

    this.sendResponse(ws, uniqueId, 'StatusNotification', {});
  }

  handleStartTransaction(ws, uniqueId, payload) {
    const { connectorId, idTag, meterStart, timestamp } = payload;
    
    // Find the charge point
    let chargePoint = null;
    for (const [id, cp] of this.chargePoints.entries()) {
      if (cp.ws === ws) {
        chargePoint = cp;
        break;
      }
    }

    if (chargePoint) {
      const transactionId = Math.floor(Math.random() * 1000000);
      chargePoint.currentTransaction = {
        id: transactionId,
        connectorId,
        idTag,
        meterStart,
        startTime: timestamp,
        status: 'Charging'
      };
      
      console.log(`Transaction started: ${transactionId} for charge point ${chargePoint.id}`);
    }

    this.sendResponse(ws, uniqueId, 'StartTransaction', {
      transactionId: chargePoint?.currentTransaction?.id || 0,
      idTagInfo: {
        status: 'Accepted'
      }
    });
  }

  handleStopTransaction(ws, uniqueId, payload) {
    const { transactionId, timestamp, meterStop, reason } = payload;
    
    // Find the charge point
    let chargePoint = null;
    for (const [id, cp] of this.chargePoints.entries()) {
      if (cp.ws === ws) {
        chargePoint = cp;
        break;
      }
    }

    if (chargePoint && chargePoint.currentTransaction) {
      console.log(`Transaction stopped: ${transactionId} for charge point ${chargePoint.id}`);
      chargePoint.currentTransaction = null;
    }

    this.sendResponse(ws, uniqueId, 'StopTransaction', {
      idTagInfo: {
        status: 'Accepted'
      }
    });
  }

  handleMeterValues(ws, uniqueId, payload) {
    const { connectorId, transactionId, meterValue } = payload;
    
    console.log(`Meter values received for connector ${connectorId}, transaction ${transactionId}:`, 
      meterValue.map(mv => mv.sampledValue.map(sv => `${sv.value} ${sv.unit || ''}`)).flat());

    this.sendResponse(ws, uniqueId, 'MeterValues', {});
  }

  handleHeartbeat(ws, uniqueId, payload) {
    // Update last seen time
    for (const [id, cp] of this.chargePoints.entries()) {
      if (cp.ws === ws) {
        cp.lastSeen = new Date();
        break;
      }
    }

    this.sendResponse(ws, uniqueId, 'Heartbeat', {
      currentTime: new Date().toISOString()
    });
  }

  handleAuthorize(ws, uniqueId, payload) {
    const { idTag } = payload;
    
    console.log(`Authorization request for tag: ${idTag}`);

    this.sendResponse(ws, uniqueId, 'Authorize', {
      idTagInfo: {
        status: 'Accepted'
      }
    });
  }

  handleDataTransfer(ws, uniqueId, payload) {
    const { vendorId, messageId, data } = payload;
    
    console.log(`Data transfer from ${vendorId}: ${messageId}`, data);

    this.sendResponse(ws, uniqueId, 'DataTransfer', {
      status: 'Accepted'
    });
  }

  handleChangeConfiguration(ws, uniqueId, payload) {
    const { key, value } = payload;
    
    console.log(`Configuration change request: ${key} = ${value}`);

    this.sendResponse(ws, uniqueId, 'ChangeConfiguration', {
      status: 'Accepted'
    });
  }

  handleGetConfiguration(ws, uniqueId, payload) {
    const { key } = payload;
    
    console.log(`Configuration request for: ${key}`);

    this.sendResponse(ws, uniqueId, 'GetConfiguration', {
      configurationKey: [
        {
          key: key,
          readonly: false,
          value: 'demo_value'
        }
      ],
      unknownKey: []
    });
  }

  handleRemoteStartTransaction(ws, uniqueId, payload) {
    const { connectorId, idTag } = payload;
    
    console.log(`Remote start transaction request: connector ${connectorId}, tag ${idTag}`);

    this.sendResponse(ws, uniqueId, 'RemoteStartTransaction', {
      status: 'Accepted'
    });
  }

  handleRemoteStopTransaction(ws, uniqueId, payload) {
    const { transactionId } = payload;
    
    console.log(`Remote stop transaction request: ${transactionId}`);

    this.sendResponse(ws, uniqueId, 'RemoteStopTransaction', {
      status: 'Accepted'
    });
  }

  sendMessage(ws, action, payload) {
    const message = [2, uuidv4(), action, payload];
    ws.send(JSON.stringify(message));
    console.log(`Sent message: ${action}`, payload);
  }

  sendResponse(ws, uniqueId, action, payload) {
    const message = [3, uniqueId, action, payload];
    ws.send(JSON.stringify(message));
  }

  sendError(ws, errorCode, errorDescription) {
    const message = [4, uuidv4(), errorCode, errorDescription, {}];
    ws.send(JSON.stringify(message));
  }
}

// Start the server
const server = new OCPPCentralServer();
console.log('OCPP Central Server Demo started!');
console.log('Web interface: http://localhost:8080');
console.log('OCPP WebSocket: ws://localhost:8081');


