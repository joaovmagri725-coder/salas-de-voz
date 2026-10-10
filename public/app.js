const $ = s => document.querySelector(s);
const socket = io();
let ice = [{ urls: 'stun:stun.l.google.com:19302' }];
fetch('/ice').then(r => r.json()).then(j => ice = j).catch(() => {});

const peers = new Map(); // id -> {pc, name, polite, making, ignore, cam, scr:[], streams:Set}
let local = null, screen = null, myId = null, camTrack = null;

if (!navigator.mediaDevices?.getDisplayMedia) $('#scr').style.display = 'none';

async function start(create) {
  $('#err').textContent = '';
  try { local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch { return $('#err').textContent = 'Permita o acesso ao microfone (precisa de HTTPS).'; }
  const room = $('#rname').value;
  socket.emit(create ? 'create' : 'join', { room, password: $('#pw').value, name: $('#name').value }, res => {
    if (res.error) { local.getTracks().forEach(t => t.stop()); return $('#err').textContent = res.error; }
    myId = res.id;
    $('#lobby').style.display = 'none'; $('#room').style.display = 'flex';
    $('#title').textContent = (res.locked ? '🔒 ' : '') + room;
    addTile('me', 'Você', local, true);
    res.peers.forEach(p => makePeer(p.id, p.name));
    updateCount();
  });
}
$('#create').onclick = () => start(true);
$('#join').onclick = () => start(false);

function makePeer(id, name) {
  if (peers.has(id)) return peers.get(id);
  const pc = new RTCPeerConnection({ iceServers: ice });
  const p = { pc, name, polite: myId < id, making: false, ignore: false, cam: null, scr: [], streams: new Set() };
  peers.set(id, p);
  pc.onicecandidate = e => e.candidate && socket.emit('signal', { to: id, data: { candidate: e.candidate } });
  pc.onnegotiationneeded = async () => {
    try { p.making = true; await pc.setLocalDescription(); socket.emit('signal', { to: id, data: { description: pc.localDescription } }); }
    finally { p.making = false; }
  };
  pc.ontrack = e => {
    const s = e.streams[0]; if (!s) return;
    p.streams.add(s.id);
    addTile(s.id, name + (p.streams.size > 1 ? ' (tela)' : ''), s, false);
    e.track.onunmute = () => addTile(s.id, name, s, false);
    s.onremovetrack = () => {
      if (!s.getTracks().length) { removeTile(s.id); p.streams.delete(s.id); }
      else addTile(s.id, name, s, false);
    };
  };
  local.getTracks().forEach(t => { const s = pc.addTrack(t, local); if (t.kind === 'video') p.cam = s; });
  if (screen) screen.getTracks().forEach(t => p.scr.push(pc.addTrack(t, screen)));
  updateCount();
  return p;
}

socket.on('peer-joined', ({ id, name }) => makePeer(id, name));
socket.on('peer-left', id => {
  const p = peers.get(id); if (!p) return;
  p.streams.forEach(removeTile); p.pc.close(); peers.delete(id); updateCount();
});
socket.on('signal', async ({ from, data }) => {
  const p = peers.get(from); if (!p) return;
  const pc = p.pc;
  try {
    if (data.description) {
      const d = data.description;
      const collision = d.type === 'offer' && (p.making || pc.signalingState !== 'stable');
      p.ignore = !p.polite && collision;
      if (p.ignore) return;
      await pc.setRemoteDescription(d);
      if (d.type === 'offer') { await pc.setLocalDescription(); socket.emit('signal', { to: from, data: { description: pc.localDescription } }); }
    } else if (data.candidate) {
      try { await pc.addIceCandidate(data.candidate); } catch (e) { if (!p.ignore) throw e; }
    }
  } catch (e) { console.warn(e); }
});

function addTile(id, label, stream, muted) {
  let t = document.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!t) {
    t = document.createElement('div'); t.className = 'tile'; t.dataset.id = id;
    const v = document.createElement('video'); v.autoplay = true; v.playsInline = true; v.muted = muted;
    const s = document.createElement('span'); s.textContent = label;
    const fs = document.createElement('b'); fs.textContent = '⛶'; fs.title = 'Tela cheia';
    fs.onclick = e => { e.stopPropagation(); (t.requestFullscreen || t.webkitRequestFullscreen)?.call(t); };
    t.onclick = () => toggleBig(t);
    t.append(v, s, fs); $('#grid').append(t);
  }
  const v = t.querySelector('video');
  v.srcObject = null;
  v.srcObject = new MediaStream(stream.getTracks());
  v.play().catch(() => {});
}
function toggleBig(t) {
  const was = t.classList.contains('big');
  document.querySelectorAll('.tile.big').forEach(x => x.classList.remove('big'));
  if (!was) t.classList.add('big');
  $('#grid').classList.toggle('focus', !was);
}
function removeTile(id) {
  const t = document.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (t?.classList.contains('big')) $('#grid').classList.remove('focus');
  t?.remove();
}
function updateCount() { $('#count').textContent = (peers.size + 1) + ' na sala'; }

$('#mic').onclick = e => {
  const t = local.getAudioTracks()[0]; t.enabled = !t.enabled;
  e.target.textContent = t.enabled ? '🎤 Mutar' : '🔇 Ativar mic'; e.target.classList.toggle('off', !t.enabled);
};
$('#cam').onclick = async e => {
  if (!camTrack) {
    try { camTrack = (await navigator.mediaDevices.getUserMedia({ video: true })).getVideoTracks()[0]; } catch { return; }
    local.addTrack(camTrack);
    peers.forEach(p => p.cam = p.pc.addTrack(camTrack, local));
    addTile('me', 'Você', local, true);
    e.target.textContent = '📷 Desligar câmera';
  } else {
    camTrack.stop(); local.removeTrack(camTrack);
    peers.forEach(p => { if (p.cam) p.pc.removeTrack(p.cam); p.cam = null; });
    camTrack = null; e.target.textContent = '📷 Câmera';
    addTile('me', 'Você', local, true);
  }
};
async function stopScreen() {
  if (!screen) return;
  screen.getTracks().forEach(t => t.stop());
  peers.forEach(p => { p.scr.forEach(s => { try { p.pc.removeTrack(s); } catch {} }); p.scr = []; });
  removeTile('screen'); screen = null; $('#scr').textContent = '🖥️ Compartilhar tela';
}
$('#scr').onclick = async () => {
  if (screen) return stopScreen();
  try { screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }); } catch { return; }
  peers.forEach(p => screen.getTracks().forEach(t => p.scr.push(p.pc.addTrack(t, screen))));
  addTile('screen', 'Sua tela', screen, true);
  screen.getVideoTracks()[0].onended = stopScreen;
  $('#scr').textContent = '🛑 Parar compartilhamento';
};
$('#out').onclick = () => { socket.emit('leave'); location.reload(); };
