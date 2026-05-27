#!/bin/bash

echo "Starting OCPP Central Server Demo..."
echo

echo "Installing dependencies..."
npm install

echo
echo "Starting OCPP Central Server..."
gnome-terminal --title="OCPP Server" -- bash -c "npm start; exec bash" &

echo
echo "Waiting for server to start..."
sleep 3

echo
echo "Starting Demo Charge Point Client..."
gnome-terminal --title="Demo Client" -- bash -c "npm run test; exec bash" &

echo
echo "Opening web interface..."
sleep 2
xdg-open http://localhost:8080

echo
echo "Demo started successfully!"
echo "- Web Interface: http://localhost:8080"
echo "- OCPP WebSocket: ws://localhost:8081"
echo "- Server Console: Check the 'OCPP Server' window"
echo "- Client Console: Check the 'Demo Client' window"
echo


