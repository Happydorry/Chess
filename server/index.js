require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const registerSocketHandlers = require('./server');
const { connectDB } = require('./db');
const { router: authRouter } = require('./auth');
const { router: usersRouter } = require('./users');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
  },
});

app.get('/', (req, res) => {
  res.send('Chess server running');
});

// Accounts / authentication (optional layer — guest play needs none of this).
app.use('/api/auth', authRouter);

// Public player profiles (viewable by anyone, including guests).
app.use('/api/users', usersRouter);

registerSocketHandlers(io);

// Connect to MongoDB in the background. Non-blocking on purpose: the server
// listens and serves guest games immediately even while the DB is connecting
// or if it's unavailable.
connectDB();

// Hosts (Render, Railway, Fly, etc.) inject the port to bind via PORT.
// Fall back to 5001 for local development.
const PORT = process.env.PORT || 5001;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
