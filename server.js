const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 });
const MAX_PEERS = 6; // malha WebRTC: acima de ~6 pessoas fica pesado

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss: ws:; media-src 'self' blob:; img-src 'self' data:; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self)',
    'Strict-Transport-Security': 'max-age=31536000'
  });
  next();
});
app.use(express.static('public'));

// Servidores STUN/TURN (configure ICE_SERVERS no painel do host para usar TURN)
app.get('/ice', (req, res) => {
  let ice = [{ urls: 'stun:stun.l.google.com:19302' }];
  try { if (process.env.ICE_SERVERS) ice = JSON.parse(process.env.ICE_SERVERS); } catch {}
  res.json(ice);
});

const rooms = new Map(); // nome -> { salt, hash, peers: Map(id -> nome) }

const clean = (s, max) => String(s || '').trim().slice(0, max);
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32);

function enter(socket, { room, password, name }, create, cb) {
  if (typeof cb !== 'function') return;
  if (socket.data.room) return cb({ error: 'Você já está em uma sala.' });
  if (socket.data.fails >= 5) { cb({ error: 'Muitas tentativas.' }); return socket.disconnect(true); }
  room = clean(room, 40).toLowerCase(); name = clean(name, 24); password = String(password || '').slice(0, 100);
  if (!/^[a-z0-9À-ÿ _-]{2,40}$/i.test(room)) return cb({ error: 'Nome de sala inválido (2-40 letras/números).' });
  if (!name) return cb({ error: 'Digite seu nome.' });

  let r = rooms.get(room);
  if (create) {
    if (r) return cb({ error: 'Já existe uma sala com esse nome.' });
    const salt = crypto.randomBytes(16);
    r = { salt, hash: password ? hashPw(password, salt) : null, peers: new Map() };
    rooms.set(room, r);
  } else {
    if (!r) { socket.data.fails = (socket.data.fails || 0) + 1; return cb({ error: 'Sala não encontrada.' }); }
    if (r.hash) {
      const ok = crypto.timingSafeEqual(r.hash, hashPw(password, r.salt));
      if (!ok) { socket.data.fails = (socket.data.fails || 0) + 1; return cb({ error: 'Senha incorreta.' }); }
    }
  }
  if (r.peers.size >= MAX_PEERS) return cb({ error: 'Sala cheia.' });

  const others = [...r.peers].map(([id, n]) => ({ id, name: n }));
  r.peers.set(socket.id, name);
  socket.data.room = room;
  socket.join(room);
  socket.to(room).emit('peer-joined', { id: socket.id, name });
  cb({ ok: true, id: socket.id, peers: others, locked: !!r.hash });
}

function leave(socket) {
  const room = socket.data.room; if (!room) return;
  const r = rooms.get(room);
  socket.leave(room); socket.data.room = null;
  if (!r) return;
  r.peers.delete(socket.id);
  socket.to(room).emit('peer-left', socket.id);
  if (!r.peers.size) rooms.delete(room);
}

io.on('connection', (socket) => {
  socket.data.fails = 0;
  socket.on('create', (d, cb) => enter(socket, d || {}, true, cb));
  socket.on('join', (d, cb) => enter(socket, d || {}, false, cb));
  socket.on('signal', ({ to, data } = {}) => {
    const r = rooms.get(socket.data.room);
    if (r && r.peers.has(to)) io.to(to).emit('signal', { from: socket.id, data });
  });
  socket.on('leave', () => leave(socket));
  socket.on('disconnect', () => leave(socket));
});

server.listen(process.env.PORT || 3000, () => console.log('Rodando'));
