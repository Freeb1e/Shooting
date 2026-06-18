const express = require("express");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const TICK_RATE = 60;
const DEFAULT_MAP_ID = "open_field";
const ORIGINAL_TICK_RATE = 30;
const TICK_SCALE = ORIGINAL_TICK_RATE / TICK_RATE;

const PLAYER_RADIUS = 18;
const BASE_PLAYER_SPEED = 4 * TICK_SCALE;
const PLAYER_MAX_HP = 100;
const RESPAWN_TICKS = TICK_RATE * 3;
const NEXT_ROUND_TICKS = TICK_RATE * 5;

const NAME_MAX_LENGTH = 16;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

const weaponConfig = loadWeaponConfig();
const WEAPONS = weaponConfig.weapons;
const DEFAULT_WEAPON_ID = weaponConfig.defaultWeaponId;

const MAPS = {
  open_field: {
    id: "open_field",
    name: "开阔训练场",
    width: 1800,
    height: 1100,
    description: "远距离交火多，适合狙击和拉扯。",
    obstacles: [
      { x: 420, y: 230, w: 130, h: 90 },
      { x: 780, y: 480, w: 260, h: 80 },
      { x: 1240, y: 260, w: 130, h: 170 },
      { x: 320, y: 760, w: 210, h: 70 },
      { x: 1180, y: 780, w: 280, h: 70 },
      { x: 850, y: 170, w: 80, h: 120 }
    ]
  },
  alley: {
    id: "alley",
    name: "巷战街区",
    width: 1500,
    height: 950,
    description: "狭窄通道和拐角多，适合冲锋枪和霰弹枪。",
    obstacles: [
      { x: 260, y: 120, w: 90, h: 620 },
      { x: 520, y: 260, w: 90, h: 570 },
      { x: 780, y: 120, w: 90, h: 620 },
      { x: 1040, y: 260, w: 90, h: 570 },
      { x: 260, y: 120, w: 440, h: 70 },
      { x: 780, y: 760, w: 350, h: 70 },
      { x: 1180, y: 120, w: 70, h: 260 },
      { x: 1180, y: 560, w: 70, h: 270 }
    ]
  },
  arena: {
    id: "arena",
    name: "中心竞技场",
    width: 1600,
    height: 1000,
    description: "中心掩体争夺激烈，中距离武器较均衡。",
    obstacles: [
      { x: 700, y: 420, w: 200, h: 160 },
      { x: 420, y: 260, w: 150, h: 90 },
      { x: 1030, y: 260, w: 150, h: 90 },
      { x: 420, y: 650, w: 150, h: 90 },
      { x: 1030, y: 650, w: 150, h: 90 },
      { x: 180, y: 440, w: 180, h: 90 },
      { x: 1240, y: 440, w: 180, h: 90 },
      { x: 740, y: 120, w: 120, h: 120 },
      { x: 740, y: 760, w: 120, h: 120 }
    ]
  }
};

const players = {};
const bullets = [];
let nextBulletId = 1;
let gameMode = "deathmatch";
let roundState = "playing";
let roundNumber = 1;
let winner = null;
let nextRoundTimer = 0;
let currentMapId = DEFAULT_MAP_ID;

app.use(express.static("public"));

io.on("connection", (socket) => {
  socket.emit("self", socket.id);

  socket.on("join", (data) => {
    if (players[socket.id]) return;

    const name = sanitizeName(data && data.name);
    const color = sanitizeColor(data && data.color);
    const spawn = getRandomSpawnPoint();

    players[socket.id] = {
      id: socket.id,
      name,
      x: spawn.x,
      y: spawn.y,
      targetX: spawn.x,
      targetY: spawn.y,
      radius: PLAYER_RADIUS,
      speed: BASE_PLAYER_SPEED,
      hp: PLAYER_MAX_HP,
      maxHp: PLAYER_MAX_HP,
      color,
      alive: true,
      respawnTimer: 0,
      kills: 0,
      deaths: 0,
      currentWeapon: DEFAULT_WEAPON_ID,
      weapons: createWeaponStates()
    };

    socket.emit("joined", { id: socket.id });
  });

  socket.on("move", (data) => {
    const player = players[socket.id];
    if (!player || !player.alive || !isValidPoint(data)) return;

    const target = clampPointToMap(data.x, data.y, player.radius);
    player.targetX = target.x;
    player.targetY = target.y;
  });

  socket.on("shoot", (data) => {
    const player = players[socket.id];
    if (!player || !player.alive || roundState !== "playing" || !isValidAngle(data && data.angle)) return;

    shootWeapon(player, data.angle);
  });

  socket.on("switchWeapon", (data) => {
    const player = players[socket.id];
    if (!player || !isValidWeaponId(data && data.weaponId)) return;

    player.currentWeapon = data.weaponId;
  });

  socket.on("reload", () => {
    const player = players[socket.id];
    if (!player || !player.alive) return;

    startReload(player);
  });

  socket.on("setMode", (data) => {
    if (!players[socket.id] || !isValidMode(data && data.mode)) return;
    if (data.mode === gameMode) return;

    gameMode = data.mode;
    roundNumber = 0;
    startNewRound();
  });

  socket.on("setMap", (data) => {
    if (!players[socket.id] || !isValidMapId(data && data.mapId)) return;
    if (data.mapId === currentMapId) return;

    currentMapId = data.mapId;
    roundNumber = 0;
    startNewRound();
  });

  socket.on("disconnect", () => {
    delete players[socket.id];
    if (gameMode === "survival") {
      checkSurvivalWinner();
    }
  });
});

setInterval(() => {
  updatePlayers();
  updateBullets();
  updateRespawns();
  updateRound();
  broadcastState();
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`Game server is running at http://localhost:${PORT}`);
});

function updatePlayers() {
  for (const player of Object.values(players)) {
    updateWeaponState(player);

    if (!player.alive) continue;

    const dx = player.targetX - player.x;
    const dy = player.targetY - player.y;
    const distance = Math.hypot(dx, dy);

    const speed = getPlayerSpeed(player);

    if (distance <= speed) {
      const target = clampPointToMap(player.targetX, player.targetY, player.radius);
      if (!circleHitsAnyObstacle(target.x, target.y, player.radius)) {
        player.x = target.x;
        player.y = target.y;
      }
      continue;
    }

    // Move one small step toward the target. If that step hits a wall,
    // keep the player in place for this tick.
    const nextX = player.x + (dx / distance) * speed;
    const nextY = player.y + (dy / distance) * speed;
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
      bullet.x > getCurrentMap().width ||
      bullet.y < 0 ||
      bullet.y > getCurrentMap().height ||
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
        killPlayer(hitPlayer, bullet.ownerId);
        checkSurvivalWinner();
      }
    }
  }
}

function updateWeaponState(player) {
  if (!player || !player.alive) return;

  for (const weaponId of Object.keys(player.weapons)) {
    const weaponState = player.weapons[weaponId];
    if (weaponState.cooldownRemaining > 0) weaponState.cooldownRemaining -= 1;
    if (weaponState.reloadRemaining > 0) {
      weaponState.reloadRemaining -= 1;
      if (weaponState.reloadRemaining <= 0) {
        weaponState.loaded = weaponState.magazineSize;
        weaponState.reloadRemaining = 0;
      }
    }
  }
}

function updateRespawns() {
  if (gameMode !== "deathmatch") return;

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

function updateRound() {
  if (gameMode !== "survival" || roundState !== "ended") return;

  nextRoundTimer -= 1;
  if (nextRoundTimer <= 0) {
    startNewRound();
  }
}

function broadcastState() {
  io.emit("state", {
    players,
    bullets,
    obstacles: getCurrentMap().obstacles,
    mapWidth: getCurrentMap().width,
    mapHeight: getCurrentMap().height,
    currentMapId,
    maps: getPublicMapConfigs(),
    gameMode,
    roundState,
    roundNumber,
    winner,
    nextRoundTimer,
    tickRate: TICK_RATE,
    weapons: getPublicWeaponConfigs()
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
    const map = getCurrentMap();
    const x = randomBetween(PLAYER_RADIUS, map.width - PLAYER_RADIUS);
    const y = randomBetween(PLAYER_RADIUS, map.height - PLAYER_RADIUS);

    if (!circleHitsAnyObstacle(x, y, PLAYER_RADIUS)) {
      return { x, y };
    }
  }

  return { x: PLAYER_RADIUS + 20, y: PLAYER_RADIUS + 20 };
}

function killPlayer(player, killerId) {
  player.hp = 0;
  player.alive = false;
  player.respawnTimer = gameMode === "deathmatch" ? RESPAWN_TICKS : 0;
  player.deaths += 1;
  refillAllWeapons(player);

  const killer = players[killerId];
  if (killer && killer.id !== player.id) {
    killer.kills += 1;
  }
}

function checkSurvivalWinner() {
  if (gameMode !== "survival" || roundState !== "playing") return;

  const joinedPlayers = Object.values(players);
  if (joinedPlayers.length < 2) return;

  const alivePlayers = joinedPlayers.filter((player) => player.alive);
  if (alivePlayers.length === 1) {
    endRound(alivePlayers[0]);
  }
}

function endRound(winningPlayer) {
  roundState = "ended";
  nextRoundTimer = NEXT_ROUND_TICKS;
  bullets.length = 0;
  winner = winningPlayer
    ? {
        id: winningPlayer.id,
        name: winningPlayer.name,
        color: winningPlayer.color
      }
    : null;
}

function startNewRound() {
  roundState = "playing";
  roundNumber += 1;
  winner = null;
  nextRoundTimer = 0;
  bullets.length = 0;

  for (const player of Object.values(players)) {
    respawnPlayer(player);
    refillAllWeapons(player);
  }
}

function respawnPlayer(player) {
  const spawn = getRandomSpawnPoint();
  player.x = spawn.x;
  player.y = spawn.y;
  player.targetX = spawn.x;
  player.targetY = spawn.y;
  player.hp = player.maxHp;
  player.alive = true;
  player.respawnTimer = 0;
}

function shootWeapon(player, angle) {
  const weapon = WEAPONS[player.currentWeapon] || WEAPONS[DEFAULT_WEAPON_ID];
  const weaponState = player.weapons[player.currentWeapon] || player.weapons[DEFAULT_WEAPON_ID];

  if (!weaponState || weaponState.reloadRemaining > 0 || weaponState.cooldownRemaining > 0) return;
  if (weaponState.loaded <= 0) {
    startReload(player);
    return;
  }

  weaponState.loaded -= 1;
  weaponState.cooldownRemaining = weapon.cooldownTicks;

  const totalSpread = weapon.spread;
  const startAngle = angle - totalSpread / 2;
  const step = weapon.pelletCount > 1 ? totalSpread / Math.max(1, weapon.pelletCount - 1) : 0;

  for (let i = 0; i < weapon.pelletCount; i++) {
    const pelletAngle = weapon.pelletCount === 1 ? angle : startAngle + step * i;
    bullets.push({
      id: nextBulletId++,
      ownerId: player.id,
      weaponId: weapon.id,
      x: player.x + Math.cos(pelletAngle) * (player.radius + weapon.bulletRadius + 2),
      y: player.y + Math.sin(pelletAngle) * (player.radius + weapon.bulletRadius + 2),
      vx: Math.cos(pelletAngle) * weapon.bulletSpeed,
      vy: Math.sin(pelletAngle) * weapon.bulletSpeed,
      radius: weapon.bulletRadius,
      damage: weapon.damage,
      life: weapon.bulletLife
    });
  }

  if (weaponState.loaded <= 0) {
    startReload(player);
  }
}

function startReload(player) {
  const weapon = WEAPONS[player.currentWeapon] || WEAPONS[DEFAULT_WEAPON_ID];
  const weaponState = player.weapons[player.currentWeapon] || player.weapons[DEFAULT_WEAPON_ID];

  if (!weaponState || weaponState.reloadRemaining > 0 || weaponState.loaded >= weapon.magazineSize) return;

  weaponState.reloadRemaining = weapon.reloadTicks;
  weaponState.cooldownRemaining = Math.max(weaponState.cooldownRemaining, weapon.reloadTicks);
}

function refillAllWeapons(player) {
  for (const weaponId of Object.keys(player.weapons)) {
    const weapon = WEAPONS[weaponId];
    const weaponState = player.weapons[weaponId];
    weaponState.loaded = weapon.magazineSize;
    weaponState.cooldownRemaining = 0;
    weaponState.reloadRemaining = 0;
  }
  player.currentWeapon = DEFAULT_WEAPON_ID;
}

function createWeaponStates() {
  const states = {};
  for (const weaponId of Object.keys(WEAPONS)) {
    const weapon = WEAPONS[weaponId];
    states[weaponId] = {
      loaded: weapon.magazineSize,
      magazineSize: weapon.magazineSize,
      cooldownRemaining: 0,
      reloadRemaining: 0
    };
  }
  return states;
}

function circleHitsAnyObstacle(x, y, radius) {
  return getCurrentMap().obstacles.some((obstacle) => circleRectCollision(x, y, radius, obstacle));
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
    data.x <= getCurrentMap().width &&
    data.y >= 0 &&
    data.y <= getCurrentMap().height
  );
}

function isValidAngle(angle) {
  return Number.isFinite(angle) && angle >= -Math.PI * 2 && angle <= Math.PI * 2;
}

function isValidMode(mode) {
  return mode === "deathmatch" || mode === "survival";
}

function isValidWeaponId(weaponId) {
  return typeof weaponId === "string" && Boolean(WEAPONS[weaponId]);
}

function isValidMapId(mapId) {
  return typeof mapId === "string" && Boolean(MAPS[mapId]);
}

function clampPointToMap(x, y, radius) {
  const map = getCurrentMap();
  return {
    x: clamp(x, radius, map.width - radius),
    y: clamp(y, radius, map.height - radius)
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

function sanitizeName(name) {
  if (typeof name !== "string") {
    return "Player";
  }

  const trimmed = name.trim().replace(/\s+/g, " ").slice(0, NAME_MAX_LENGTH);
  return trimmed || "Player";
}

function sanitizeColor(color) {
  if (typeof color === "string" && COLOR_PATTERN.test(color)) {
    return color;
  }

  return randomHexColor();
}

function randomHexColor() {
  const value = Math.floor(Math.random() * 0xffffff);
  return `#${value.toString(16).padStart(6, "0")}`;
}

function getPublicWeaponConfigs() {
  const configs = {};
  for (const [weaponId, weapon] of Object.entries(WEAPONS)) {
    configs[weaponId] = {
      id: weapon.id,
      name: weapon.name,
      magazineSize: weapon.magazineSize,
      cooldownTicks: weapon.cooldownTicks,
      reloadTicks: weapon.reloadTicks,
      pelletCount: weapon.pelletCount,
      moveSpeedMultiplier: weapon.moveSpeedMultiplier,
      bulletSpeed: weapon.config.bulletSpeed,
      bulletLifeSeconds: weapon.config.bulletLifeSeconds,
      cooldownMs: weapon.config.cooldownMs,
      reloadMs: weapon.config.reloadMs,
      spreadDegrees: weapon.config.spreadDegrees
    };
  }
  return configs;
}

function getPublicMapConfigs() {
  const configs = {};
  for (const [mapId, map] of Object.entries(MAPS)) {
    configs[mapId] = {
      id: map.id,
      name: map.name,
      width: map.width,
      height: map.height,
      description: map.description
    };
  }
  return configs;
}

function getCurrentMap() {
  return MAPS[currentMapId] || MAPS[DEFAULT_MAP_ID];
}

function getPlayerSpeed(player) {
  const weapon = WEAPONS[player.currentWeapon] || WEAPONS[DEFAULT_WEAPON_ID];
  return BASE_PLAYER_SPEED * weapon.moveSpeedMultiplier;
}

function loadWeaponConfig() {
  const configPath = path.join(__dirname, "config", "weapons.json");
  const rawConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const weapons = {};

  for (const [weaponId, weapon] of Object.entries(rawConfig.weapons || {})) {
    weapons[weaponId] = normalizeWeaponConfig(weaponId, weapon);
  }

  const defaultWeaponId = rawConfig.defaultWeaponId || Object.keys(weapons)[0];
  if (!defaultWeaponId || !weapons[defaultWeaponId]) {
    throw new Error("config/weapons.json must define a valid defaultWeaponId.");
  }

  return {
    defaultWeaponId,
    weapons
  };
}

function normalizeWeaponConfig(weaponId, weapon) {
  const bulletLifeSeconds = getNumber(weapon.bulletLifeSeconds, 3);
  const cooldownMs = getNumber(weapon.cooldownMs, 250);
  const reloadMs = getNumber(weapon.reloadMs, 1000);
  const spreadDegrees = getNumber(weapon.spreadDegrees, 0);

  return {
    id: weapon.id || weaponId,
    name: weapon.name || weaponId,
    magazineSize: Math.max(1, Math.round(getNumber(weapon.magazineSize, 1))),
    damage: getNumber(weapon.damage, 1),
    bulletRadius: Math.max(1, getNumber(weapon.bulletRadius, 4)),
    bulletSpeed: getNumber(weapon.bulletSpeed, 10) * TICK_SCALE,
    bulletLife: Math.max(1, Math.round(bulletLifeSeconds * TICK_RATE)),
    cooldownTicks: msToTicks(cooldownMs),
    reloadTicks: msToTicks(reloadMs),
    pelletCount: Math.max(1, Math.round(getNumber(weapon.pelletCount, 1))),
    spread: degreesToRadians(spreadDegrees),
    moveSpeedMultiplier: getNumber(weapon.moveSpeedMultiplier, 1),
    config: {
      bulletSpeed: getNumber(weapon.bulletSpeed, 10),
      bulletLifeSeconds,
      cooldownMs,
      reloadMs,
      spreadDegrees
    }
  };
}

function getNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function msToTicks(ms) {
  return Math.max(1, Math.round((ms / 1000) * TICK_RATE));
}

function degreesToRadians(degrees) {
  return (degrees * Math.PI) / 180;
}
