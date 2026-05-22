const { v4: uuidv4 } = require('uuid');

const rooms = {}; // in-memory store

function registerSocketHandlers(io) {
  io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // CREATE ROOM
    socket.on('create_room', () => {
      const roomId = uuidv4().slice(0, 6).toUpperCase(); // e.g. "A3F9B2"
      rooms[roomId] = {
        white: socket.id,
        black: null,
        fen: 'start', // initial board state
      };
      socket.join(roomId);
      socket.emit('room_created', { roomId, color: 'white' });
    });

    // JOIN ROOM
    socket.on('join_room', ({ roomId }) => {
      const room = rooms[roomId];

      if (!room) return socket.emit('error', { msg: 'Room not found' });
      if (room.black) return socket.emit('error', { msg: 'Room is full' });

      room.black = socket.id;
      socket.join(roomId);
      socket.emit('room_joined', { roomId, color: 'black' });

      // Notify white player that opponent joined — game can start
      io.to(room.white).emit('opponent_joined');
    });

    // CLEANUP on disconnect
    socket.on('disconnect', () => {
      console.log('User disconnected:', socket.id);
      for (const [roomId, room] of Object.entries(rooms)) {
        if (room.white === socket.id || room.black === socket.id) {
          io.to(roomId).emit('opponent_left');
          delete rooms[roomId];
        }
      }
    });
  });
}

module.exports = registerSocketHandlers;
