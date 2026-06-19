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
const BROADCAST_RATE = 20;
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
const itemConfig = loadItemConfig();
const ITEMS = itemConfig.items;
const MAX_ACTIVE_ITEMS = itemConfig.maxActiveItems;

const mapConfig = loadMapConfig();
const MAPS = mapConfig.maps;

const players = {};
const bullets = [];
const activeItems = [];
const itemSpawnCooldowns = {};
let nextBulletId = 1;
let nextItemId = 1;
let gameMode = "deathmatch";
let roundState = "playing";
let roundNumber = 1;
let winner = null;
let nextRoundTimer = 0;
let currentMapId = mapConfig.defaultMapId;
let itemsEnabled = itemConfig.enabledByDefault;

app.use(express.static("public"));

io.on("connection", (socket) => {
  socket.emit("self", socket.id);
  socket.emit("config", getStaticConfig());

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
      fallbackWeaponAfterDrop: DEFAULT_WEAPON_ID,
      lastProcessedInputSeq: 0,
      weapons: createWeaponStates(),
      buffs: createBuffState()
    };

    socket.emit("joined", { id: socket.id });
    socket.emit("config", getStaticConfig());
  });

  socket.on("move", (data) => {
    const player = players[socket.id];
    if (!player || !player.alive || !isValidPoint(data)) return;

    const target = clampPointToMap(data.x, data.y, player.radius);
    player.targetX = target.x;
    player.targetY = target.y;
    player.lastProcessedInputSeq = Math.max(player.lastProcessedInputSeq || 0, getInputSeq(data));
  });

  socket.on("shoot", (data) => {
    const player = players[socket.id];
    if (!player || !player.alive || roundState !== "playing" || !isValidAngle(data && data.angle)) return;

    const inputSeq = getInputSeq(data);
    shootWeapon(player, data.angle, inputSeq);
    player.lastProcessedInputSeq = Math.max(player.lastProcessedInputSeq || 0, inputSeq);
  });

  socket.on("switchWeapon", (data) => {
    const player = players[socket.id];
    if (!player || !isValidWeaponId(data && data.weaponId)) return;
    ensurePracticeWeapon(player, data.weaponId);
    if (!canPlayerUseWeapon(player, data.weaponId)) return;

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
    broadcastConfigToAll();
  });

  socket.on("setMap", (data) => {
    if (!players[socket.id] || !isValidMapId(data && data.mapId)) return;
    if (data.mapId === currentMapId) return;

    currentMapId = data.mapId;
    roundNumber = 0;
    startNewRound();
    broadcastConfigToAll();
  });

  socket.on("setItemsEnabled", (data) => {
    if (!players[socket.id] || typeof (data && data.enabled) !== "boolean") return;

    itemsEnabled = data.enabled;
    resetItems();
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
  updateItems();
  updateRespawns();
  updateRound();
}, 1000 / TICK_RATE);

setInterval(() => {
  broadcastState();
}, 1000 / BROADCAST_RATE);

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
      applyDamage(hitPlayer, bullet.damage);
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

  updateBuffState(player);

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

function updateBuffState(player) {
  if (!player.buffs) {
    player.buffs = createBuffState();
  }

  if (player.buffs.speedRemaining > 0) {
    player.buffs.speedRemaining -= 1;
    if (player.buffs.speedRemaining <= 0) {
      player.buffs.speedRemaining = 0;
      player.buffs.speedMultiplier = 1;
    }
  }

  if (player.buffs.shieldRemaining > 0) {
    player.buffs.shieldRemaining -= 1;
    if (player.buffs.shieldRemaining <= 0) {
      player.buffs.shieldRemaining = 0;
      player.buffs.shield = 0;
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

function updateItems() {
  if (!itemsEnabled) return;

  updateItemSpawnCooldowns();
  spawnItems();
  collectItems();
}

function updateItemSpawnCooldowns() {
  const map = getCurrentMap();
  for (let i = 0; i < map.itemSpawnPoints.length; i++) {
    const key = getSpawnPointKey("item", i);
    itemSpawnCooldowns[key] = Math.max(0, (itemSpawnCooldowns[key] || 0) - 1);
  }
  for (let i = 0; i < map.weaponDropPoints.length; i++) {
    const key = getSpawnPointKey("weapon", i);
    itemSpawnCooldowns[key] = Math.max(0, (itemSpawnCooldowns[key] || 0) - 1);
  }
}

function spawnItems() {
  if (activeItems.length >= MAX_ACTIVE_ITEMS) return;

  const map = getCurrentMap();
  const normalItemIds = Object.keys(ITEMS).filter((itemId) => ITEMS[itemId].type !== "weapon_drop");
  const weaponDropItem = Object.values(ITEMS).find((item) => item.type === "weapon_drop");

  for (let i = 0; i < map.itemSpawnPoints.length; i++) {
    if (activeItems.length >= MAX_ACTIVE_ITEMS) return;
    if (normalItemIds.length === 0) break;

    const key = getSpawnPointKey("item", i);
    const occupied = activeItems.some((item) => item.spawnType === "item" && item.spawnIndex === i);
    if (occupied || (itemSpawnCooldowns[key] || 0) > 0) continue;

    const item = ITEMS[normalItemIds[Math.floor(Math.random() * normalItemIds.length)]];
    const point = map.itemSpawnPoints[i];
    if (!isSpawnPointClear(point, item.radius)) continue;

    activeItems.push(createItemInstance(item, point, "item", i));
    itemSpawnCooldowns[key] = item.spawnCooldownTicks;
  }

  if (!weaponDropItem) return;

  for (let i = 0; i < map.weaponDropPoints.length; i++) {
    if (activeItems.length >= MAX_ACTIVE_ITEMS) return;

    const key = getSpawnPointKey("weapon", i);
    const occupied = activeItems.some((item) => item.spawnType === "weapon" && item.spawnIndex === i);
    if (occupied || (itemSpawnCooldowns[key] || 0) > 0) continue;

    const point = map.weaponDropPoints[i];
    if (!isSpawnPointClear(point, weaponDropItem.radius)) continue;

    activeItems.push(createItemInstance(weaponDropItem, point, "weapon", i));
    itemSpawnCooldowns[key] = weaponDropItem.spawnCooldownTicks;
  }
}

function collectItems() {
  for (let i = activeItems.length - 1; i >= 0; i--) {
    const item = activeItems[i];
    const player = findItemCollector(item);
    if (!player) continue;

    applyItem(player, item);
    activeItems.splice(i, 1);
  }
}

function findItemCollector(item) {
  for (const player of Object.values(players)) {
    if (!player.alive) continue;

    if (distanceBetween(player.x, player.y, item.x, item.y) <= player.radius + item.radius) {
      return player;
    }
  }

  return null;
}

function applyItem(player, itemInstance) {
  const item = ITEMS[itemInstance.itemId];
  if (!item) return;

  if (item.type === "heal") {
    player.hp = clamp(player.hp + item.amount, 0, player.maxHp);
  }

  if (item.type === "ammo") {
    refillCurrentWeapon(player);
  }

  if (item.type === "speed") {
    player.buffs.speedMultiplier = item.multiplier;
    player.buffs.speedRemaining = item.durationTicks;
  }

  if (item.type === "shield") {
    player.buffs.shield = Math.max(player.buffs.shield, item.amount);
    player.buffs.shieldRemaining = item.durationTicks;
  }

  if (item.type === "weapon_drop") {
    giveDropWeapon(player, item);
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
    items: activeItems,
    itemsEnabled,
    gameMode,
    roundState,
    roundNumber,
    winner,
    nextRoundTimer,
    tickRate: TICK_RATE,
    broadcastRate: BROADCAST_RATE
  });
}

function broadcastConfigToAll() {
  io.emit("config", getStaticConfig());
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
  clearBuffs(player);

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
  resetItems();

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
  clearBuffs(player);
}

function shootWeapon(player, angle, clientSeq) {
  const weapon = WEAPONS[player.currentWeapon] || WEAPONS[DEFAULT_WEAPON_ID];
  const weaponState = player.weapons[player.currentWeapon] || player.weapons[DEFAULT_WEAPON_ID];

  if (!weaponState || weaponState.reloadRemaining > 0 || weaponState.cooldownRemaining > 0) return false;
  if (weaponState.loaded <= 0) {
    handleEmptyWeapon(player, weapon);
    return false;
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
      clientSeq,
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
    handleEmptyWeapon(player, weapon);
  }

  return true;
}

function startReload(player) {
  const weapon = WEAPONS[player.currentWeapon] || WEAPONS[DEFAULT_WEAPON_ID];
  const weaponState = player.weapons[player.currentWeapon] || player.weapons[DEFAULT_WEAPON_ID];

  if (isLimitedDropWeapon(weapon)) return;
  if (!weaponState || weaponState.reloadRemaining > 0 || weaponState.loaded >= weapon.magazineSize) return;

  weaponState.reloadRemaining = weapon.reloadTicks;
  weaponState.cooldownRemaining = Math.max(weaponState.cooldownRemaining, weapon.reloadTicks);
}

function handleEmptyWeapon(player, weapon) {
  if (isLimitedDropWeapon(weapon)) {
    removeDropWeapon(player, weapon.id);
    return;
  }

  startReload(player);
}

function refillAllWeapons(player) {
  for (const weaponId of Object.keys(player.weapons)) {
    const weapon = WEAPONS[weaponId];
    if (weapon.dropOnly && gameMode !== "deathmatch") {
      delete player.weapons[weaponId];
      continue;
    }

    const weaponState = player.weapons[weaponId];
    weaponState.loaded = weapon.magazineSize;
    weaponState.cooldownRemaining = 0;
    weaponState.reloadRemaining = 0;
  }
  player.currentWeapon = DEFAULT_WEAPON_ID;
  player.fallbackWeaponAfterDrop = DEFAULT_WEAPON_ID;
}

function giveDropWeapon(player, item) {
  const availableWeaponIds = item.weaponPool.filter((weaponId) => WEAPONS[weaponId]);
  if (availableWeaponIds.length === 0) return;

  const weaponId = availableWeaponIds[Math.floor(Math.random() * availableWeaponIds.length)];
  const weapon = WEAPONS[weaponId];
  const currentWeapon = WEAPONS[player.currentWeapon];
  if (!currentWeapon || !currentWeapon.dropOnly) {
    player.fallbackWeaponAfterDrop = player.currentWeapon;
  }

  player.weapons[weaponId] = {
    loaded: weapon.magazineSize,
    magazineSize: weapon.magazineSize,
    cooldownRemaining: 0,
    reloadRemaining: 0
  };
  player.currentWeapon = weaponId;
}

function removeDropWeapon(player, weaponId) {
  delete player.weapons[weaponId];

  const fallbackWeaponId = canPlayerUseWeapon(player, player.fallbackWeaponAfterDrop)
    ? player.fallbackWeaponAfterDrop
    : DEFAULT_WEAPON_ID;

  player.currentWeapon = fallbackWeaponId;
  player.fallbackWeaponAfterDrop = fallbackWeaponId;
}

function refillCurrentWeapon(player) {
  const weapon = WEAPONS[player.currentWeapon] || WEAPONS[DEFAULT_WEAPON_ID];
  const weaponState = player.weapons[player.currentWeapon] || player.weapons[DEFAULT_WEAPON_ID];
  if (isLimitedDropWeapon(weapon)) return;

  weaponState.loaded = weapon.magazineSize;
  weaponState.reloadRemaining = 0;
  weaponState.cooldownRemaining = 0;
}

function createWeaponStates() {
  const states = {};
  for (const weaponId of Object.keys(WEAPONS)) {
    const weapon = WEAPONS[weaponId];
    if (weapon.dropOnly) continue;

    states[weaponId] = {
      loaded: weapon.magazineSize,
      magazineSize: weapon.magazineSize,
      cooldownRemaining: 0,
      reloadRemaining: 0
    };
  }
  return states;
}

function createBuffState() {
  return {
    speedMultiplier: 1,
    speedRemaining: 0,
    shield: 0,
    shieldRemaining: 0
  };
}

function clearBuffs(player) {
  player.buffs = createBuffState();
}

function applyDamage(player, damage) {
  let remainingDamage = damage;

  if (player.buffs && player.buffs.shield > 0) {
    const absorbed = Math.min(player.buffs.shield, remainingDamage);
    player.buffs.shield -= absorbed;
    remainingDamage -= absorbed;
    if (player.buffs.shield <= 0) {
      player.buffs.shield = 0;
      player.buffs.shieldRemaining = 0;
    }
  }

  player.hp -= remainingDamage;
}

function resetItems() {
  activeItems.length = 0;
  for (const key of Object.keys(itemSpawnCooldowns)) {
    delete itemSpawnCooldowns[key];
  }
}

function createItemInstance(item, point, spawnType, spawnIndex) {
  const instance = {
    id: nextItemId++,
    itemId: item.id,
    name: item.name,
    type: item.type,
    x: point.x,
    y: point.y,
    radius: item.radius,
    color: item.color,
    spawnType,
    spawnIndex
  };

  if (item.type === "weapon_drop") {
    instance.weaponPool = item.weaponPool;
  }

  return instance;
}

function isSpawnPointClear(point, radius) {
  const map = getCurrentMap();
  const insideMap =
    point.x >= radius &&
    point.x <= map.width - radius &&
    point.y >= radius &&
    point.y <= map.height - radius;

  return insideMap && !circleHitsAnyObstacle(point.x, point.y, radius);
}

function getSpawnPointKey(type, index) {
  return `${currentMapId}:${type}:${index}`;
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

function getInputSeq(data) {
  return data && Number.isSafeInteger(data.seq) && data.seq > 0 ? data.seq : 0;
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

function canPlayerUseWeapon(player, weaponId) {
  return isValidWeaponId(weaponId) && Boolean(player.weapons[weaponId]);
}

function ensurePracticeWeapon(player, weaponId) {
  if (gameMode !== "deathmatch" || player.weapons[weaponId]) return;

  const weapon = WEAPONS[weaponId];
  player.weapons[weaponId] = {
    loaded: weapon.magazineSize,
    magazineSize: weapon.magazineSize,
    cooldownRemaining: 0,
    reloadRemaining: 0
  };
}

function isLimitedDropWeapon(weapon) {
  return weapon.dropOnly && gameMode !== "deathmatch";
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
      bulletRadius: weapon.bulletRadius,
      moveSpeedMultiplier: weapon.moveSpeedMultiplier,
      bulletSpeed: weapon.config.bulletSpeed,
      bulletLifeSeconds: weapon.config.bulletLifeSeconds,
      cooldownMs: weapon.config.cooldownMs,
      reloadMs: weapon.config.reloadMs,
      spreadDegrees: weapon.config.spreadDegrees,
      dropOnly: weapon.dropOnly
    };
  }
  return configs;
}

function getStaticConfig() {
  return {
    itemConfigs: getPublicItemConfigs(),
    obstacles: getCurrentMap().obstacles,
    mapWidth: getCurrentMap().width,
    mapHeight: getCurrentMap().height,
    currentMapId,
    maps: getPublicMapConfigs(),
    tickRate: TICK_RATE,
    broadcastRate: BROADCAST_RATE,
    weapons: getPublicWeaponConfigs()
  };
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
  const buffMultiplier = player.buffs ? player.buffs.speedMultiplier : 1;
  return BASE_PLAYER_SPEED * weapon.moveSpeedMultiplier * buffMultiplier;
}

function loadMapConfig() {
  const configPath = path.join(__dirname, "config", "maps.json");
  const rawConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const maps = {};

  for (const [mapId, map] of Object.entries(rawConfig.maps || {})) {
    maps[mapId] = normalizeMapConfig(mapId, map);
  }

  const defaultMapId = rawConfig.defaultMapId || DEFAULT_MAP_ID;
  if (!maps[defaultMapId]) {
    throw new Error("config/maps.json must define a valid defaultMapId.");
  }

  return {
    defaultMapId,
    maps
  };
}

function normalizeMapConfig(mapId, map) {
  return {
    id: map.id || mapId,
    name: map.name || mapId,
    width: Math.max(PLAYER_RADIUS * 2, Math.round(getNumber(map.width, 1200))),
    height: Math.max(PLAYER_RADIUS * 2, Math.round(getNumber(map.height, 800))),
    description: map.description || "",
    obstacles: normalizeRectList(map.obstacles),
    itemSpawnPoints: normalizePointList(map.itemSpawnPoints),
    weaponDropPoints: normalizePointList(map.weaponDropPoints)
  };
}

function normalizeRectList(rects) {
  if (!Array.isArray(rects)) return [];

  return rects
    .map((rect) => ({
      x: getNumber(rect && rect.x, 0),
      y: getNumber(rect && rect.y, 0),
      w: Math.max(1, getNumber(rect && rect.w, 1)),
      h: Math.max(1, getNumber(rect && rect.h, 1))
    }))
    .filter((rect) => Number.isFinite(rect.x) && Number.isFinite(rect.y));
}

function normalizePointList(points) {
  if (!Array.isArray(points)) return [];

  return points
    .map((point) => ({
      x: getNumber(point && point.x, 0),
      y: getNumber(point && point.y, 0)
    }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
}

function loadItemConfig() {
  const configPath = path.join(__dirname, "config", "items.json");
  const rawConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const items = {};

  for (const [itemId, item] of Object.entries(rawConfig.items || {})) {
    items[itemId] = normalizeItemConfig(itemId, item);
  }

  return {
    enabledByDefault: rawConfig.enabledByDefault !== false,
    maxActiveItems: Math.max(0, Math.round(getNumber(rawConfig.maxActiveItems, 8))),
    items
  };
}

function normalizeItemConfig(itemId, item) {
  const durationSeconds = getNumber(item.durationSeconds, 0);
  const spawnCooldownSeconds = getNumber(item.spawnCooldownSeconds, 10);

  return {
    id: item.id || itemId,
    name: item.name || itemId,
    type: item.type || "heal",
    amount: getNumber(item.amount, 0),
    target: item.target || "currentWeapon",
    multiplier: getNumber(item.multiplier, 1),
    durationTicks: Math.max(0, Math.round(durationSeconds * TICK_RATE)),
    spawnCooldownTicks: Math.max(1, Math.round(spawnCooldownSeconds * TICK_RATE)),
    radius: Math.max(1, getNumber(item.radius, 14)),
    color: typeof item.color === "string" ? item.color : "#ffffff",
    weaponPool: Array.isArray(item.weaponPool) ? item.weaponPool.filter((weaponId) => typeof weaponId === "string") : [],
    config: {
      durationSeconds,
      spawnCooldownSeconds
    }
  };
}

function getPublicItemConfigs() {
  const configs = {};
  for (const [itemId, item] of Object.entries(ITEMS)) {
    configs[itemId] = {
      id: item.id,
      name: item.name,
      type: item.type,
      amount: item.amount,
      target: item.target,
      multiplier: item.multiplier,
      durationSeconds: item.config.durationSeconds,
      spawnCooldownSeconds: item.config.spawnCooldownSeconds,
      radius: item.radius,
      color: item.color,
      weaponPool: item.weaponPool
    };
  }
  return configs;
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
    dropOnly: weapon.dropOnly === true,
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
