const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const registerSocketHandlers = require('./server');

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
  },
});

app.get('/', (req, res) => {
  res.send('Chess server running');
});

registerSocketHandlers(io);

// Hosts (Render, Railway, Fly, etc.) inject the port to bind via PORT.
// Fall back to 5001 for local development.
const PORT = process.env.PORT || 5001;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
