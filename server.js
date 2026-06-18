const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const TICK_RATE = 30;
const MAP_WIDTH = 1600;
const MAP_HEIGHT = 1000;

const PLAYER_RADIUS = 18;
const PLAYER_SPEED = 4;
const PLAYER_MAX_HP = 100;
const RESPAWN_TICKS = TICK_RATE * 3;

const BULLET_RADIUS = 5;
const BULLET_SPEED = 12;
const BULLET_DAMAGE = 20;
const BULLET_LIFE = 90;

const players = {};
const bullets = [];
let nextBulletId = 1;

const obstacles = [
  { x: 400, y: 300, w: 200, h: 80 },
  { x: 900, y: 500, w: 100, h: 250 },
  { x: 1200, y: 200, w: 250, h: 100 }
];

app.use(express.static("public"));

io.on("connection", (socket) => {
  const spawn = getRandomSpawnPoint();

  players[socket.id] = {
    id: socket.id,
    x: spawn.x,
    y: spawn.y,
    targetX: spawn.x,
    targetY: spawn.y,
    radius: PLAYER_RADIUS,
    speed: PLAYER_SPEED,
    hp: PLAYER_MAX_HP,
    maxHp: PLAYER_MAX_HP,
    color: randomColor(),
    alive: true,
    respawnTimer: 0
  };

  socket.emit("self", socket.id);

  socket.on("move", (data) => {
    const player = players[socket.id];
    if (!player || !player.alive || !isValidPoint(data)) return;

    const target = clampPointToMap(data.x, data.y, player.radius);
    player.targetX = target.x;
    player.targetY = target.y;
  });

  socket.on("shoot", (data) => {
    const player = players[socket.id];
    if (!player || !player.alive || !isValidAngle(data && data.angle)) return;

    const angle = data.angle;
    bullets.push({
      id: nextBulletId++,
      ownerId: socket.id,
      x: player.x + Math.cos(angle) * (player.radius + BULLET_RADIUS + 2),
      y: player.y + Math.sin(angle) * (player.radius + BULLET_RADIUS + 2),
      vx: Math.cos(angle) * BULLET_SPEED,
      vy: Math.sin(angle) * BULLET_SPEED,
      radius: BULLET_RADIUS,
      damage: BULLET_DAMAGE,
      life: BULLET_LIFE
    });
  });

  socket.on("disconnect", () => {
    delete players[socket.id];
  });
});

setInterval(() => {
  updatePlayers();
  updateBullets();
  updateRespawns();
  broadcastState();
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`Game server is running at http://localhost:${PORT}`);
});

function updatePlayers() {
  for (const player of Object.values(players)) {
    if (!player.alive) continue;

    const dx = player.targetX - player.x;
    const dy = player.targetY - player.y;
    const distance = Math.hypot(dx, dy);

    if (distance <= player.speed) {
      const target = clampPointToMap(player.targetX, player.targetY, player.radius);
      if (!circleHitsAnyObstacle(target.x, target.y, player.radius)) {
        player.x = target.x;
        player.y = target.y;
      }
      continue;
    }

    // Move one small step toward the target. If that step hits a wall,
    // keep the player in place for this tick.
    const nextX = player.x + (dx / distance) * player.speed;
    const nextY = player.y + (dy / distance) * player.speed;
    const clamped = clampPointToMap(nextX, nextY, player.radius);

    if (!circleHitsAnyObstacle(clamped.x, clamped.y, player.radius)) {
      player.x = clamped.x;
      player.y = clamped.y;
    }
  }
}

function updateBullets() {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const bullet = bullets[i];
    bullet.x += bullet.vx;
    bullet.y += bullet.vy;
    bullet.life -= 1;

    if (
      bullet.life <= 0 ||
      bullet.x < 0 ||
      bullet.x > MAP_WIDTH ||
      bullet.y < 0 ||
      bullet.y > MAP_HEIGHT ||
      circleHitsAnyObstacle(bullet.x, bullet.y, bullet.radius)
    ) {
      bullets.splice(i, 1);
      continue;
    }

    // The server is authoritative: it decides whether bullets damage players.
    const hitPlayer = findHitPlayer(bullet);
    if (hitPlayer) {
      hitPlayer.hp -= bullet.damage;
      bullets.splice(i, 1);

      if (hitPlayer.hp <= 0) {
        hitPlayer.hp = 0;
        hitPlayer.alive = false;
        hitPlayer.respawnTimer = RESPAWN_TICKS;
      }
    }
  }
}

function updateRespawns() {
  for (const player of Object.values(players)) {
    if (player.alive) continue;

    player.respawnTimer -= 1;
    if (player.respawnTimer > 0) continue;

    const spawn = getRandomSpawnPoint();
    player.x = spawn.x;
    player.y = spawn.y;
    player.targetX = spawn.x;
    player.targetY = spawn.y;
    player.hp = player.maxHp;
    player.alive = true;
    player.respawnTimer = 0;
  }
}

function broadcastState() {
  io.emit("state", {
    players,
    bullets,
    obstacles,
    mapWidth: MAP_WIDTH,
    mapHeight: MAP_HEIGHT
  });
}

function findHitPlayer(bullet) {
  for (const player of Object.values(players)) {
    if (!player.alive || player.id === bullet.ownerId) continue;

    const hitDistance = player.radius + bullet.radius;
    if (distanceBetween(player.x, player.y, bullet.x, bullet.y) <= hitDistance) {
      return player;
    }
  }

  return null;
}

function getRandomSpawnPoint() {
  for (let i = 0; i < 500; i++) {
    const x = randomBetween(PLAYER_RADIUS, MAP_WIDTH - PLAYER_RADIUS);
    const y = randomBetween(PLAYER_RADIUS, MAP_HEIGHT - PLAYER_RADIUS);

    if (!circleHitsAnyObstacle(x, y, PLAYER_RADIUS)) {
      return { x, y };
    }
  }

  return { x: PLAYER_RADIUS + 20, y: PLAYER_RADIUS + 20 };
}

function circleHitsAnyObstacle(x, y, radius) {
  return obstacles.some((obstacle) => circleRectCollision(x, y, radius, obstacle));
}

function circleRectCollision(circleX, circleY, radius, rect) {
  const nearestX = clamp(circleX, rect.x, rect.x + rect.w);
  const nearestY = clamp(circleY, rect.y, rect.y + rect.h);
  return distanceBetween(circleX, circleY, nearestX, nearestY) < radius;
}

function isValidPoint(data) {
  return (
    data &&
    Number.isFinite(data.x) &&
    Number.isFinite(data.y) &&
    data.x >= 0 &&
    data.x <= MAP_WIDTH &&
    data.y >= 0 &&
    data.y <= MAP_HEIGHT
  );
}

function isValidAngle(angle) {
  return Number.isFinite(angle) && angle >= -Math.PI * 2 && angle <= Math.PI * 2;
}

function clampPointToMap(x, y, radius) {
  return {
    x: clamp(x, radius, MAP_WIDTH - radius),
    y: clamp(y, radius, MAP_HEIGHT - radius)
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function distanceBetween(x1, y1, x2, y2) {
  return Math.hypot(x2 - x1, y2 - y1);
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function randomColor() {
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue}, 80%, 60%)`;
}
