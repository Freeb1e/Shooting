const socket = io();
const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

let selfId = null;
let latestState = null;
let mouseScreen = { x: 0, y: 0 };
let camera = { x: 0, y: 0 };
let moveMarkers = [];

socket.on("self", (id) => {
  selfId = id;
});

socket.on("state", (state) => {
  latestState = state;
});

window.addEventListener("resize", resizeCanvas);
resizeCanvas();

canvas.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

canvas.addEventListener("mousemove", (event) => {
  mouseScreen = getMouseScreenPosition(event);
});

canvas.addEventListener("mousedown", (event) => {
  if (!latestState) return;

  const world = screenToWorld(mouseScreen.x, mouseScreen.y);

  if (event.button === 2) {
    addMoveMarker(world.x, world.y);
    socket.emit("move", { x: world.x, y: world.y });
  }

  if (event.button === 0) {
    const me = latestState.players[selfId];
    if (!me || !me.alive) return;

    const angle = Math.atan2(world.y - me.y, world.x - me.x);
    socket.emit("shoot", { angle });
  }
});

requestAnimationFrame(render);

function render() {
  requestAnimationFrame(render);

  updateMoveMarkers();
  ctx.fillStyle = "#101318";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!latestState) {
    drawLoadingText();
    return;
  }

  updateCamera();
  drawWorld();
  drawHud();
}

function updateCamera() {
  const me = latestState.players[selfId];
  const focusX = me ? me.x : latestState.mapWidth / 2;
  const focusY = me ? me.y : latestState.mapHeight / 2;

  camera.x = clamp(focusX - canvas.width / 2, 0, Math.max(0, latestState.mapWidth - canvas.width));
  camera.y = clamp(focusY - canvas.height / 2, 0, Math.max(0, latestState.mapHeight - canvas.height));
}

function drawWorld() {
  drawGrid();
  drawMapBorder();
  drawMoveMarkers();

  for (const obstacle of latestState.obstacles) {
    drawObstacle(obstacle);
  }

  for (const bullet of latestState.bullets) {
    drawBullet(bullet);
  }

  for (const player of Object.values(latestState.players)) {
    drawPlayer(player);
  }

  drawCrosshair();
}

function drawGrid() {
  ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
  ctx.lineWidth = 1;

  const startX = Math.floor(camera.x / 80) * 80;
  const startY = Math.floor(camera.y / 80) * 80;

  for (let x = startX; x <= camera.x + canvas.width; x += 80) {
    const screen = worldToScreen(x, 0);
    ctx.beginPath();
    ctx.moveTo(screen.x, 0);
    ctx.lineTo(screen.x, canvas.height);
    ctx.stroke();
  }

  for (let y = startY; y <= camera.y + canvas.height; y += 80) {
    const screen = worldToScreen(0, y);
    ctx.beginPath();
    ctx.moveTo(0, screen.y);
    ctx.lineTo(canvas.width, screen.y);
    ctx.stroke();
  }
}

function drawMapBorder() {
  const topLeft = worldToScreen(0, 0);
  ctx.strokeStyle = "#77808f";
  ctx.lineWidth = 4;
  ctx.strokeRect(topLeft.x, topLeft.y, latestState.mapWidth, latestState.mapHeight);
}

function drawObstacle(obstacle) {
  const screen = worldToScreen(obstacle.x, obstacle.y);
  ctx.fillStyle = "#394250";
  ctx.fillRect(screen.x, screen.y, obstacle.w, obstacle.h);
  ctx.strokeStyle = "#6d7786";
  ctx.lineWidth = 2;
  ctx.strokeRect(screen.x, screen.y, obstacle.w, obstacle.h);
}

function drawPlayer(player) {
  const screen = worldToScreen(player.x, player.y);

  ctx.save();
  ctx.globalAlpha = player.alive ? 1 : 0.42;
  ctx.fillStyle = player.alive ? player.color : "#9aa0a6";
  ctx.beginPath();
  ctx.arc(screen.x, screen.y, player.radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.lineWidth = player.id === selfId ? 4 : 2;
  ctx.strokeStyle = player.id === selfId ? "#ffffff" : "rgba(255, 255, 255, 0.55)";
  ctx.stroke();
  ctx.restore();

  drawHealthBar(player, screen.x, screen.y - player.radius - 14);
}

function drawHealthBar(player, x, y) {
  const width = 46;
  const height = 6;
  const hpRatio = player.maxHp > 0 ? player.hp / player.maxHp : 0;

  ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
  ctx.fillRect(x - width / 2, y, width, height);
  ctx.fillStyle = hpRatio > 0.35 ? "#35d07f" : "#ff5a5f";
  ctx.fillRect(x - width / 2, y, width * hpRatio, height);
}

function drawBullet(bullet) {
  const screen = worldToScreen(bullet.x, bullet.y);

  ctx.fillStyle = "#ffd166";
  ctx.beginPath();
  ctx.arc(screen.x, screen.y, bullet.radius, 0, Math.PI * 2);
  ctx.fill();
}

function drawCrosshair() {
  const size = 7;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(mouseScreen.x - size, mouseScreen.y);
  ctx.lineTo(mouseScreen.x + size, mouseScreen.y);
  ctx.moveTo(mouseScreen.x, mouseScreen.y - size);
  ctx.lineTo(mouseScreen.x, mouseScreen.y + size);
  ctx.stroke();
}

function drawMoveMarkers() {
  for (const marker of moveMarkers) {
    const screen = worldToScreen(marker.x, marker.y);
    const progress = marker.life / marker.maxLife;
    const radius = 8 + (1 - progress) * 14;

    ctx.save();
    ctx.globalAlpha = Math.max(0, progress);
    ctx.strokeStyle = "#7ee0ff";
    ctx.lineWidth = 2;

    // A short click pulse gives immediate movement feedback like MOBA path pings.
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(screen.x - 10, screen.y);
    ctx.lineTo(screen.x + 10, screen.y);
    ctx.moveTo(screen.x, screen.y - 10);
    ctx.lineTo(screen.x, screen.y + 10);
    ctx.stroke();
    ctx.restore();
  }
}

function drawHud() {
  const players = Object.values(latestState.players);
  const me = latestState.players[selfId];
  const hpText = me ? `${me.hp}/${me.maxHp}` : "-";

  ctx.fillStyle = "rgba(0, 0, 0, 0.42)";
  ctx.fillRect(14, 14, 250, 86);

  ctx.fillStyle = "#f3f6fb";
  ctx.font = "16px Arial, sans-serif";
  ctx.fillText(`在线人数：${players.length}`, 28, 40);
  ctx.fillText(`我的血量：${hpText}`, 28, 64);
  ctx.fillText("右键移动，左键射击", 28, 88);
}

function drawLoadingText() {
  ctx.fillStyle = "#f3f6fb";
  ctx.font = "18px Arial, sans-serif";
  ctx.fillText("正在连接服务器...", 24, 42);
}

function screenToWorld(screenX, screenY) {
  return {
    x: screenX + camera.x,
    y: screenY + camera.y
  };
}

function worldToScreen(worldX, worldY) {
  return {
    x: worldX - camera.x,
    y: worldY - camera.y
  };
}

function getMouseScreenPosition(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  };
}

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}

function addMoveMarker(x, y) {
  moveMarkers.push({
    x,
    y,
    life: 24,
    maxLife: 24
  });
}

function updateMoveMarkers() {
  moveMarkers = moveMarkers.filter((marker) => {
    marker.life -= 1;
    return marker.life > 0;
  });
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
