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

server.listen(5001, () => {
  console.log('Server running on port 5001');
});
