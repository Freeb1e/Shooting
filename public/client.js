const socket = io();
const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");
const joinPanel = document.getElementById("joinPanel");
const gameControls = document.getElementById("gameControls");
const mapControls = document.getElementById("mapControls");
const itemsToggle = document.getElementById("itemsToggle");
const statusPanel = document.getElementById("statusPanel");
const weaponStatus = document.getElementById("weaponStatus");
const playerStatusList = document.getElementById("playerStatusList");
const playerNameInput = document.getElementById("playerName");
const colorOptions = document.getElementById("colorOptions");

let selfId = null;
let latestState = null;
let latestConfig = null;
let mouseScreen = { x: 0, y: 0 };
let camera = { x: 0, y: 0 };
let moveMarkers = [];
let joinedGame = false;
let selectedColor = "#4cc9f0";
let lastStatusPanelUpdate = 0;
let inputSeq = 0;
let predictedSelf = null;
let predictedRemotePlayers = {};
let pendingInputs = [];
let renderBullets = [];
let nextRenderBulletId = 1;
let lastRenderTime = performance.now();
const STATUS_PANEL_UPDATE_MS = 200;
const BASE_CLIENT_PLAYER_SPEED = 2;
const SERVER_FRAME_MS = 1000 / 60;
const RECONCILE_NUDGE_DISTANCE = 24;
const RECONCILE_SNAP_DISTANCE = 120;
const BULLET_RECONCILE_NUDGE_DISTANCE = 18;
const BULLET_RECONCILE_SNAP_DISTANCE = 90;

const availableColors = [
  "#4cc9f0",
  "#f72585",
  "#80ed99",
  "#ffd166",
  "#b517ff",
  "#ff7b54",
  "#90be6d",
  "#577590",
  "#f94144",
  "#43aa8b",
  "#f9c74f",
  "#9b5de5"
];
const baseWeaponSlots = ["pistol", "smg", "shotgun", "sniper"];

socket.on("self", (id) => {
  selfId = id;
});

socket.on("state", (state) => {
  latestState = {
    ...(latestConfig || {}),
    ...state
  };
  reconcileLocalPrediction();
  setupMapControls();
  updateModeButtons();
  updateMapButtons();
  updateItemsToggle();
  updateStatusPanel(false);
});

socket.on("shot", (shot) => {
  reconcileShotBullets(shot);
});

socket.on("config", (config) => {
  const previousMapId = latestState && latestState.currentMapId;
  latestConfig = config;
  latestState = {
    ...(latestState || {}),
    ...config
  };
  resetPredictionIfMapChanged(previousMapId, config.currentMapId);
  setupMapControls();
  updateModeButtons();
  updateMapButtons();
  updateStatusPanel(true);
});

socket.on("joined", () => {
  joinedGame = true;
  joinPanel.classList.add("hidden");
  gameControls.classList.remove("hidden");
  statusPanel.classList.remove("hidden");
});

setupJoinPanel();
setupGameControls();

window.addEventListener("resize", resizeCanvas);
resizeCanvas();

canvas.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

canvas.addEventListener("mousemove", (event) => {
  mouseScreen = getMouseScreenPosition(event);
});

canvas.addEventListener("mousedown", (event) => {
  if (!joinedGame || !latestState) return;

  mouseScreen = getMouseScreenPosition(event);
  const world = screenToWorld(mouseScreen.x, mouseScreen.y);

  if (event.button === 2) {
    const seq = nextInputSeq();
    addMoveMarker(world.x, world.y);
    queueMovePrediction(seq, world.x, world.y);
    socket.emit("move", { seq, x: world.x, y: world.y });
  }

  if (event.button === 0) {
    const me = latestState.players[selfId];
    if (!me || !me.alive) return;

    const shooter = predictedSelf || me;
    const angle = Math.atan2(world.y - shooter.y, world.x - shooter.x);
    const seq = nextInputSeq();
    addClientSimulatedBullet(seq, shooter, angle);
    socket.emit("shoot", { seq, angle });
  }
});

window.addEventListener("keydown", (event) => {
  if (!joinedGame) return;

  const number = Number(event.key);
  const weaponSlots = getAvailableWeaponSlots();
  if (number >= 1 && number <= weaponSlots.length) {
    socket.emit("switchWeapon", { weaponId: weaponSlots[number - 1] });
  }

  if (event.key.toLowerCase() === "r") {
    socket.emit("reload");
  }
});

requestAnimationFrame(render);

function render(frameTime = performance.now()) {
  requestAnimationFrame(render);

  const deltaScale = getFrameDeltaScale(frameTime);
  updateMoveMarkers();
  updatePredictedSelf(deltaScale);
  updatePredictedRemotePlayers(deltaScale);
  updateRenderBullets(deltaScale);
  ctx.fillStyle = "#101318";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!latestState || !latestState.players) {
    drawLoadingText();
    return;
  }

  updateCamera();
  drawWorld();
  drawHud();
}

function updateCamera() {
  const me = getRenderableSelf();
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

  for (const item of latestState.items || []) {
    drawItem(item);
  }

  for (const bullet of renderBullets) {
    drawBullet(bullet);
  }

  for (const player of getRenderablePlayers()) {
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

  drawPlayerName(player, screen.x, screen.y - player.radius - 22);
  drawHealthBar(player, screen.x, screen.y - player.radius - 14);
  drawBuffIcons(player, screen.x + 31, screen.y - player.radius - 11);
}

function drawPlayerName(player, x, y) {
  ctx.save();
  ctx.font = "13px Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = player.id === selfId ? "#ffffff" : "#d8dee9";
  ctx.fillText(player.name || "Player", x, y);
  ctx.restore();
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

function drawBuffIcons(player, x, y) {
  if (!player.buffs) return;

  const icons = [];
  if (player.buffs.speedRemaining > 0) icons.push("speed");
  if (player.buffs.shield > 0) icons.push("shield");

  for (let i = 0; i < icons.length; i++) {
    const iconX = x + i * 16;
    if (icons[i] === "speed") {
      drawSpeedBuffIcon(iconX, y);
    }
    if (icons[i] === "shield") {
      drawShieldBuffIcon(iconX, y);
    }
  }
}

function drawSpeedBuffIcon(x, y) {
  ctx.save();
  ctx.fillStyle = "#7ee0ff";
  ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + 2, y - 7);
  ctx.lineTo(x - 4, y);
  ctx.lineTo(x + 1, y);
  ctx.lineTo(x - 1, y + 7);
  ctx.lineTo(x + 6, y - 2);
  ctx.lineTo(x + 1, y - 2);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawShieldBuffIcon(x, y) {
  ctx.save();
  ctx.strokeStyle = "#8be9fd";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, 6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.75)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, 3, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawBullet(bullet) {
  const screen = worldToScreen(bullet.x, bullet.y);

  ctx.save();
  ctx.fillStyle = "#ffd166";
  ctx.beginPath();
  ctx.arc(screen.x, screen.y, bullet.radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawItem(item) {
  const screen = worldToScreen(item.x, item.y);

  ctx.save();
  ctx.fillStyle = item.color;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
  ctx.lineWidth = 2;

  if (item.type === "heal") {
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, item.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "#ffffff";
    ctx.beginPath();
    ctx.moveTo(screen.x - 7, screen.y);
    ctx.lineTo(screen.x + 7, screen.y);
    ctx.moveTo(screen.x, screen.y - 7);
    ctx.lineTo(screen.x, screen.y + 7);
    ctx.stroke();
  } else if (item.type === "ammo") {
    ctx.fillRect(screen.x - item.radius, screen.y - item.radius, item.radius * 2, item.radius * 2);
    ctx.strokeRect(screen.x - item.radius, screen.y - item.radius, item.radius * 2, item.radius * 2);
  } else if (item.type === "speed") {
    ctx.beginPath();
    ctx.moveTo(screen.x + 2, screen.y - item.radius);
    ctx.lineTo(screen.x - 8, screen.y + 1);
    ctx.lineTo(screen.x + 1, screen.y + 1);
    ctx.lineTo(screen.x - 2, screen.y + item.radius);
    ctx.lineTo(screen.x + 9, screen.y - 2);
    ctx.lineTo(screen.x, screen.y - 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else if (item.type === "shield") {
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, item.radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, item.radius - 5, 0, Math.PI * 2);
    ctx.stroke();
  } else if (item.type === "weapon_drop") {
    ctx.fillRect(screen.x - item.radius, screen.y - item.radius, item.radius * 2, item.radius * 2);
    ctx.strokeRect(screen.x - item.radius, screen.y - item.radius, item.radius * 2, item.radius * 2);
    ctx.strokeStyle = "#ffffff";
    ctx.beginPath();
    ctx.moveTo(screen.x - 8, screen.y);
    ctx.lineTo(screen.x + 8, screen.y);
    ctx.moveTo(screen.x, screen.y - 8);
    ctx.lineTo(screen.x, screen.y + 8);
    ctx.stroke();
  }

  ctx.restore();
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
  const aliveCount = players.filter((player) => player.alive).length;
  const modeText = latestState.gameMode === "survival" ? "单场生存" : "死亡竞技";
  const mapText = latestState.maps && latestState.maps[latestState.currentMapId]
    ? latestState.maps[latestState.currentMapId].name
    : "-";
  const itemsText = latestState.itemsEnabled ? "开启" : "关闭";
  const weaponText = getWeaponHudText(me);
  const weaponCount = getAvailableWeaponSlots().length;

  ctx.fillStyle = "rgba(0, 0, 0, 0.42)";
  ctx.fillRect(14, 14, 330, 206);

  ctx.fillStyle = "#f3f6fb";
  ctx.font = "16px Arial, sans-serif";
  ctx.fillText(`在线人数：${players.length}`, 28, 40);
  ctx.fillText(`我的血量：${hpText}`, 28, 64);
  ctx.fillText(`模式：${modeText}`, 28, 88);
  ctx.fillText(`地图：${mapText}`, 28, 112);
  ctx.fillText(`道具：${itemsText}`, 28, 136);
  ctx.fillText(`第 ${latestState.roundNumber || 1} 局，存活：${aliveCount}`, 28, 160);
  ctx.fillText(`武器：${weaponText}`, 28, 184);
  ctx.fillText(`1-${weaponCount} 切枪，R 换弹`, 28, 208);

  drawRoundBanner();
}

function drawLoadingText() {
  ctx.fillStyle = "#f3f6fb";
  ctx.font = "18px Arial, sans-serif";
  const text = joinedGame ? "正在连接服务器..." : "请输入玩家 ID 并选择颜色";
  ctx.fillText(text, 24, 42);
}

function drawScoreboard(players) {
  const sortedPlayers = [...players].sort((a, b) => {
    if (b.kills !== a.kills) return b.kills - a.kills;
    return a.deaths - b.deaths;
  });

  const panelWidth = 260;
  const rowHeight = 24;
  const panelHeight = 62 + Math.max(sortedPlayers.length, 1) * rowHeight;
  const x = canvas.width - panelWidth - 14;
  const y = 14;

  ctx.fillStyle = "rgba(0, 0, 0, 0.42)";
  ctx.fillRect(x, y, panelWidth, panelHeight);

  ctx.fillStyle = "#f3f6fb";
  ctx.font = "16px Arial, sans-serif";
  ctx.fillText("玩家 K/D", x + 14, y + 26);

  ctx.font = "13px Arial, sans-serif";
  ctx.fillStyle = "#b9c2d1";
  ctx.fillText("ID", x + 14, y + 46);
  ctx.fillText("K", x + 182, y + 46);
  ctx.fillText("D", x + 216, y + 46);

  for (let i = 0; i < sortedPlayers.length; i++) {
    const player = sortedPlayers[i];
    const rowY = y + 68 + i * rowHeight;

    ctx.fillStyle = player.color;
    ctx.beginPath();
    ctx.arc(x + 18, rowY - 5, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = player.id === selfId ? "#ffffff" : "#d8dee9";
    ctx.fillText(trimText(player.name || "Player", 15), x + 30, rowY);
    ctx.fillText(String(player.kills || 0), x + 182, rowY);
    ctx.fillText(String(player.deaths || 0), x + 216, rowY);
  }
}

function updateStatusPanel(force) {
  if (!latestState || !joinedGame) return;
  const now = performance.now();
  if (!force && now - lastStatusPanelUpdate < STATUS_PANEL_UPDATE_MS) return;
  lastStatusPanelUpdate = now;

  const players = Object.values(latestState.players);
  const me = latestState.players[selfId];
  updateWeaponStatus(me);
  updatePlayerStatusList(players);
}

function updateWeaponStatus(me) {
  if (!me || !latestState.weapons) {
    weaponStatus.innerHTML = "";
    return;
  }

  const currentWeapon = latestState.weapons[me.currentWeapon];
  const currentState = me.weapons && me.weapons[me.currentWeapon];
  const speedText = currentWeapon ? `${Math.round(currentWeapon.moveSpeedMultiplier * 100)}%` : "-";
  const reloadText = getWeaponStatusText(currentWeapon, currentState);

  weaponStatus.innerHTML = `
    <div class="weapon-title">
      <span>当前武器：${escapeHtml(currentWeapon ? currentWeapon.name : "-")}${currentWeapon && currentWeapon.dropOnly ? " · 空投" : ""}</span>
      <span>${escapeHtml(reloadText)}</span>
    </div>
    <div class="weapon-line">
      <span>弹药</span>
      <span>${currentState ? currentState.loaded : 0} / ${currentWeapon ? currentWeapon.magazineSize : 0}</span>
    </div>
    <div class="weapon-line">
      <span>移动速度</span>
      <span>${escapeHtml(speedText)}</span>
    </div>
    ${getBuffStatusHtml(me)}
    <div class="bar">
      <div class="bar-fill" style="width: ${getAmmoRatio(currentState, currentWeapon) * 100}%; background: #7ee0ff;"></div>
    </div>
    ${getWeaponShortcutHtml(me)}
  `;
}

function updatePlayerStatusList(players) {
  const sortedPlayers = [...players].sort((a, b) => {
    if (a.id === selfId) return -1;
    if (b.id === selfId) return 1;
    if (b.kills !== a.kills) return b.kills - a.kills;
    return a.deaths - b.deaths;
  });

  playerStatusList.innerHTML = sortedPlayers.map((player) => {
    const weapon = latestState.weapons && latestState.weapons[player.currentWeapon];
    const weaponState = player.weapons && player.weapons[player.currentWeapon];
    const speedText = weapon ? `${Math.round(weapon.moveSpeedMultiplier * 100)}%` : "-";
    const hpRatio = player.maxHp > 0 ? player.hp / player.maxHp : 0;
    const ammoRatio = getAmmoRatio(weaponState, weapon);
    const stateText = player.alive
      ? weaponState && weaponState.reloadRemaining > 0
        ? `换弹 ${formatTicks(weaponState.reloadRemaining)}s`
        : "存活"
      : "阵亡";

    return `
      <article class="player-card ${player.id === selfId ? "self" : ""}">
        <div class="player-title">
          <span class="player-dot" style="background: ${escapeHtml(player.color)};"></span>
          <span class="player-name">${escapeHtml(player.name || "Player")}</span>
          <span>${escapeHtml(stateText)}</span>
        </div>
        <div class="player-line"><span>HP</span><span>${player.hp}/${player.maxHp}</span></div>
        <div class="bar"><div class="bar-fill" style="width: ${hpRatio * 100}%; background: ${hpRatio > 0.35 ? "#35d07f" : "#ff5a5f"};"></div></div>
        <div class="player-line"><span>K/D</span><span>${player.kills || 0}/${player.deaths || 0}</span></div>
        <div class="player-line"><span>武器</span><span>${escapeHtml(weapon ? weapon.name : "-")}${weapon && weapon.dropOnly ? " · 空投" : ""}</span></div>
        <div class="player-line"><span>速度</span><span>${escapeHtml(speedText)}</span></div>
        ${getBuffStatusHtml(player)}
        <div class="player-line"><span>弹药</span><span>${weaponState ? weaponState.loaded : 0}/${weapon ? weapon.magazineSize : 0}</span></div>
        <div class="bar"><div class="bar-fill" style="width: ${ammoRatio * 100}%; background: #ffd166;"></div></div>
      </article>
    `;
  }).join("");
}

function drawRoundBanner() {
  if (latestState.gameMode !== "survival") return;

  if (latestState.roundState === "ended" && latestState.winner) {
    const tickRate = latestState.tickRate || 60;
    const seconds = Math.max(0, Math.ceil((latestState.nextRoundTimer || 0) / tickRate));
    drawCenterBanner(`${latestState.winner.name} 获胜`, `${seconds} 秒后开始下一局`);
    return;
  }

  const me = latestState.players[selfId];
  if (me && !me.alive) {
    drawCenterBanner("本局已阵亡", "等待胜者出现");
  }
}

function drawCenterBanner(title, subtitle) {
  const width = Math.min(420, canvas.width - 40);
  const height = 104;
  const x = (canvas.width - width) / 2;
  const y = 30;

  ctx.fillStyle = "rgba(0, 0, 0, 0.58)";
  ctx.fillRect(x, y, width, height);

  ctx.fillStyle = "#ffffff";
  ctx.font = "26px Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(title, canvas.width / 2, y + 43);

  ctx.fillStyle = "#b9c2d1";
  ctx.font = "16px Arial, sans-serif";
  ctx.fillText(subtitle, canvas.width / 2, y + 74);
  ctx.textAlign = "start";
}

function nextInputSeq() {
  inputSeq += 1;
  return inputSeq;
}

function queueMovePrediction(seq, x, y) {
  pendingInputs.push({ seq, type: "move", x, y });
  ensurePredictedSelf();

  if (!predictedSelf || !predictedSelf.alive) return;

  const target = clampPointToMap(x, y, predictedSelf.radius);
  predictedSelf.targetX = target.x;
  predictedSelf.targetY = target.y;
}

function reconcileLocalPrediction() {
  if (!latestState || !latestState.players || !selfId) return;

  const serverSelf = latestState.players[selfId];
  if (!serverSelf) {
    predictedSelf = null;
    predictedRemotePlayers = {};
    pendingInputs = [];
    renderBullets = [];
    return;
  }

  const acknowledgedSeq = serverSelf.lastProcessedInputSeq || 0;
  pendingInputs = pendingInputs.filter((input) => input.seq > acknowledgedSeq);
  reconcileSelfPrediction(serverSelf);
  reconcileRemotePlayerPredictions();
  reconcileRenderBullets(acknowledgedSeq);
}

function reconcileSelfPrediction(serverSelf) {
  if (!serverSelf) return;

  const previousPrediction = predictedSelf;

  if (!serverSelf.alive) {
    predictedSelf = clonePlayer(serverSelf);
    pendingInputs = [];
    return;
  }

  if (previousPrediction && previousPrediction.alive) {
    const drift = Math.hypot(previousPrediction.x - serverSelf.x, previousPrediction.y - serverSelf.y);

    predictedSelf = clonePlayer(serverSelf);
    predictedSelf.x = previousPrediction.x;
    predictedSelf.y = previousPrediction.y;
    predictedSelf.targetX = previousPrediction.targetX;
    predictedSelf.targetY = previousPrediction.targetY;

    if (drift > RECONCILE_SNAP_DISTANCE) {
      predictedSelf.x = serverSelf.x;
      predictedSelf.y = serverSelf.y;
      predictedSelf.targetX = serverSelf.targetX;
      predictedSelf.targetY = serverSelf.targetY;
    } else if (drift > RECONCILE_NUDGE_DISTANCE) {
      predictedSelf.x = lerp(previousPrediction.x, serverSelf.x, 0.08);
      predictedSelf.y = lerp(previousPrediction.y, serverSelf.y, 0.08);
    }
  } else {
    predictedSelf = clonePlayer(serverSelf);
  }

  const latestMove = [...pendingInputs].reverse().find((input) => input.type === "move");
  if (latestMove) {
    predictedSelf.targetX = latestMove.x;
    predictedSelf.targetY = latestMove.y;
  }
}

function reconcileRemotePlayerPredictions() {
  const serverPlayers = latestState.players || {};
  const nextRemotePlayers = {};

  for (const [playerId, serverPlayer] of Object.entries(serverPlayers)) {
    if (playerId === selfId) continue;

    const previousPrediction = predictedRemotePlayers[playerId];
    nextRemotePlayers[playerId] = reconcilePlayerPrediction(previousPrediction, serverPlayer);
  }

  predictedRemotePlayers = nextRemotePlayers;
}

function reconcilePlayerPrediction(previousPrediction, serverPlayer) {
  if (!previousPrediction || !previousPrediction.alive || !serverPlayer.alive) {
    return clonePlayer(serverPlayer);
  }

  const drift = Math.hypot(previousPrediction.x - serverPlayer.x, previousPrediction.y - serverPlayer.y);
  const nextPrediction = clonePlayer(serverPlayer);
  nextPrediction.x = previousPrediction.x;
  nextPrediction.y = previousPrediction.y;

  if (drift > RECONCILE_SNAP_DISTANCE) {
    nextPrediction.x = serverPlayer.x;
    nextPrediction.y = serverPlayer.y;
  } else if (drift > RECONCILE_NUDGE_DISTANCE) {
    nextPrediction.x = lerp(previousPrediction.x, serverPlayer.x, 0.08);
    nextPrediction.y = lerp(previousPrediction.y, serverPlayer.y, 0.08);
  }

  return nextPrediction;
}

function resetPredictionIfMapChanged(previousMapId, nextMapId) {
  if (!previousMapId || !nextMapId || previousMapId === nextMapId) return;

  predictedSelf = null;
  predictedRemotePlayers = {};
  pendingInputs = [];
  renderBullets = [];
}

function ensurePredictedSelf() {
  if (predictedSelf || !latestState || !latestState.players) return;

  const serverSelf = latestState.players[selfId];
  if (serverSelf) {
    predictedSelf = clonePlayer(serverSelf);
  }
}

function updatePredictedSelf(deltaScale) {
  if (!latestState || !latestState.players || !selfId) return;

  ensurePredictedSelf();
  if (!predictedSelf || !predictedSelf.alive) return;

  movePredictedPlayer(predictedSelf, deltaScale);
}

function updatePredictedRemotePlayers(deltaScale) {
  if (!latestState || !latestState.players) return;

  for (const player of Object.values(predictedRemotePlayers)) {
    if (player.alive) {
      movePredictedPlayer(player, deltaScale);
    }
  }
}

function movePredictedPlayer(player, deltaScale) {
  const dx = player.targetX - player.x;
  const dy = player.targetY - player.y;
  const distance = Math.hypot(dx, dy);
  const speed = getClientPlayerSpeed(player) * deltaScale;

  if (distance <= speed) {
    const target = clampPointToMap(player.targetX, player.targetY, player.radius);
    if (!circleHitsAnyObstacle(target.x, target.y, player.radius)) {
      player.x = target.x;
      player.y = target.y;
    }
    return;
  }

  const nextX = player.x + (dx / distance) * speed;
  const nextY = player.y + (dy / distance) * speed;
  const clamped = clampPointToMap(nextX, nextY, player.radius);

  if (!circleHitsAnyObstacle(clamped.x, clamped.y, player.radius)) {
    player.x = clamped.x;
    player.y = clamped.y;
  }
}

function addClientSimulatedBullet(seq, shooter, angle) {
  if (!latestState || !latestState.weapons) return;

  const weapon = latestState.weapons[shooter.currentWeapon];
  const weaponState = shooter.weapons && shooter.weapons[shooter.currentWeapon];
  if (!weapon || !weaponState || weaponState.loaded <= 0 || weaponState.reloadRemaining > 0 || weaponState.cooldownRemaining > 0) return;

  const pelletCount = Math.max(1, weapon.pelletCount || 1);
  const spread = degreesToRadians(weapon.spreadDegrees || 0);
  const startAngle = angle - spread / 2;
  const step = pelletCount > 1 ? spread / Math.max(1, pelletCount - 1) : 0;

  for (let i = 0; i < pelletCount; i++) {
    const pelletAngle = pelletCount === 1 ? angle : startAngle + step * i;
    const radius = weapon.bulletRadius || 4;
    const bulletSpeed = Number.isFinite(weapon.bulletSpeedPerTick)
      ? weapon.bulletSpeedPerTick
      : (weapon.bulletSpeed || 10) * 0.5;

    renderBullets.push({
      localId: `local-${nextRenderBulletId++}`,
      serverId: null,
      clientSeq: seq,
      ownerId: selfId,
      weaponId: weapon.id,
      confirmed: false,
      x: shooter.x + Math.cos(pelletAngle) * (shooter.radius + radius + 2),
      y: shooter.y + Math.sin(pelletAngle) * (shooter.radius + radius + 2),
      vx: Math.cos(pelletAngle) * bulletSpeed,
      vy: Math.sin(pelletAngle) * bulletSpeed,
      radius,
      life: Math.max(8, Math.round((weapon.bulletLifeSeconds || 1) * (latestState.tickRate || 60)))
    });
  }
}

function reconcileRenderBullets(acknowledgedSeq) {
  const matchedLocalIds = new Set();
  const serverBullets = latestState.bullets || [];

  for (const serverBullet of serverBullets) {
    const existing = findRenderBulletForServerBullet(serverBullet);
    if (existing) {
      adoptServerBullet(existing, serverBullet);
      matchedLocalIds.add(existing.localId);
      continue;
    }

    const created = createRenderBulletFromServer(serverBullet);
    renderBullets.push(created);
    matchedLocalIds.add(created.localId);
  }

  renderBullets = renderBullets.filter((bullet) => {
    if (matchedLocalIds.has(bullet.localId)) return true;
    if (!bullet.confirmed && bullet.ownerId === selfId && bullet.clientSeq > acknowledgedSeq) return true;
    return false;
  });
}

function reconcileShotBullets(shot) {
  if (!shot || !Array.isArray(shot.bullets)) return;

  for (const serverBullet of shot.bullets) {
    const existing = findRenderBulletForServerBullet(serverBullet);
    if (existing) {
      adoptServerBullet(existing, serverBullet);
      continue;
    }

    renderBullets.push(createRenderBulletFromServer(serverBullet));
  }
}

function findRenderBulletForServerBullet(serverBullet) {
  const byServerId = renderBullets.find((bullet) => bullet.serverId === serverBullet.id);
  if (byServerId) return byServerId;

  if (serverBullet.ownerId !== selfId || !Number.isSafeInteger(serverBullet.clientSeq)) return null;

  return renderBullets.find((bullet) => (
    !bullet.serverId &&
    bullet.ownerId === selfId &&
    bullet.clientSeq === serverBullet.clientSeq &&
    bullet.weaponId === serverBullet.weaponId
  ));
}

function adoptServerBullet(renderBullet, serverBullet) {
  const drift = Math.hypot(renderBullet.x - serverBullet.x, renderBullet.y - serverBullet.y);

  renderBullet.serverId = serverBullet.id;
  renderBullet.clientSeq = serverBullet.clientSeq || renderBullet.clientSeq;
  renderBullet.ownerId = serverBullet.ownerId;
  renderBullet.weaponId = serverBullet.weaponId;
  renderBullet.vx = serverBullet.vx;
  renderBullet.vy = serverBullet.vy;
  renderBullet.radius = serverBullet.radius;
  renderBullet.life = serverBullet.life;
  renderBullet.confirmed = true;

  if (drift > BULLET_RECONCILE_SNAP_DISTANCE) {
    renderBullet.x = serverBullet.x;
    renderBullet.y = serverBullet.y;
  } else if (drift > BULLET_RECONCILE_NUDGE_DISTANCE) {
    renderBullet.x = lerp(renderBullet.x, serverBullet.x, 0.18);
    renderBullet.y = lerp(renderBullet.y, serverBullet.y, 0.18);
  }
}

function createRenderBulletFromServer(serverBullet) {
  return {
    localId: `server-${serverBullet.id}`,
    serverId: serverBullet.id,
    clientSeq: serverBullet.clientSeq || 0,
    ownerId: serverBullet.ownerId,
    weaponId: serverBullet.weaponId,
    confirmed: true,
    x: serverBullet.x,
    y: serverBullet.y,
    vx: serverBullet.vx,
    vy: serverBullet.vy,
    radius: serverBullet.radius,
    life: serverBullet.life
  };
}

function updateRenderBullets(deltaScale) {
  if (!latestState) return;

  renderBullets = renderBullets.filter((bullet) => {
    bullet.x += bullet.vx * deltaScale;
    bullet.y += bullet.vy * deltaScale;
    bullet.life -= deltaScale;

    return (
      bullet.life > 0 &&
      bullet.x >= 0 &&
      bullet.x <= latestState.mapWidth &&
      bullet.y >= 0 &&
      bullet.y <= latestState.mapHeight &&
      !circleHitsAnyObstacle(bullet.x, bullet.y, bullet.radius)
    );
  });
}

function getRenderableSelf() {
  if (predictedSelf && predictedSelf.alive) return predictedSelf;
  return latestState && latestState.players ? latestState.players[selfId] : null;
}

function getRenderablePlayers() {
  const players = Object.values(latestState.players);
  return players.map((player) => {
    if (player.id === selfId && predictedSelf) return predictedSelf;
    return predictedRemotePlayers[player.id] || player;
  });
}

function clonePlayer(player) {
  return {
    ...player,
    weapons: cloneWeaponStates(player.weapons),
    buffs: player.buffs ? { ...player.buffs } : null
  };
}

function cloneWeaponStates(weapons) {
  const clone = {};
  for (const [weaponId, weaponState] of Object.entries(weapons || {})) {
    clone[weaponId] = { ...weaponState };
  }
  return clone;
}

function getClientPlayerSpeed(player) {
  const weapon = latestState.weapons && latestState.weapons[player.currentWeapon];
  const weaponMultiplier = weapon ? weapon.moveSpeedMultiplier : 1;
  const buffMultiplier = player.buffs ? player.buffs.speedMultiplier : 1;
  return BASE_CLIENT_PLAYER_SPEED * weaponMultiplier * buffMultiplier;
}

function clampPointToMap(x, y, radius) {
  return {
    x: clamp(x, radius, latestState.mapWidth - radius),
    y: clamp(y, radius, latestState.mapHeight - radius)
  };
}

function circleHitsAnyObstacle(x, y, radius) {
  return (latestState.obstacles || []).some((obstacle) => circleRectCollision(x, y, radius, obstacle));
}

function circleRectCollision(circleX, circleY, radius, rect) {
  const nearestX = clamp(circleX, rect.x, rect.x + rect.w);
  const nearestY = clamp(circleY, rect.y, rect.y + rect.h);
  return Math.hypot(circleX - nearestX, circleY - nearestY) < radius;
}

function degreesToRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function lerp(start, end, amount) {
  return start + (end - start) * amount;
}

function getFrameDeltaScale(frameTime) {
  const elapsed = Math.max(0, Math.min(100, frameTime - lastRenderTime));
  lastRenderTime = frameTime;
  return elapsed > 0 ? elapsed / SERVER_FRAME_MS : 1;
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

function setupJoinPanel() {
  playerNameInput.value = getDefaultPlayerName();

  for (const color of availableColors) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "color-option";
    button.style.backgroundColor = color;
    button.setAttribute("aria-label", `选择颜色 ${color}`);

    if (color === selectedColor) {
      button.classList.add("selected");
    }

    button.addEventListener("click", () => {
      selectedColor = color;
      for (const option of colorOptions.querySelectorAll(".color-option")) {
        option.classList.remove("selected");
      }
      button.classList.add("selected");
    });

    colorOptions.appendChild(button);
  }

  joinPanel.addEventListener("submit", (event) => {
    event.preventDefault();

    const name = playerNameInput.value.trim();
    if (!name) {
      playerNameInput.focus();
      return;
    }

    socket.emit("join", {
      name,
      color: selectedColor
    });
  });
}

function setupGameControls() {
  for (const button of gameControls.querySelectorAll(".mode-button")) {
    button.addEventListener("click", () => {
      const mode = button.dataset.mode;
      socket.emit("setMode", { mode });
    });
  }

  itemsToggle.addEventListener("click", () => {
    const nextEnabled = !(latestState && latestState.itemsEnabled);
    socket.emit("setItemsEnabled", { enabled: nextEnabled });
  });
}

function setupMapControls() {
  if (!latestState || !latestState.maps || mapControls.dataset.ready === "true") return;

  for (const map of Object.values(latestState.maps)) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.mapId = map.id;
    button.className = "mode-button";
    button.textContent = map.name;
    button.title = map.description || "";
    button.addEventListener("click", () => {
      socket.emit("setMap", { mapId: map.id });
    });
    mapControls.appendChild(button);
  }

  mapControls.dataset.ready = "true";
  updateMapButtons();
}

function updateModeButtons() {
  if (!latestState) return;

  for (const button of gameControls.querySelectorAll(".mode-button")) {
    button.classList.toggle("selected", button.dataset.mode === latestState.gameMode);
  }
}

function updateMapButtons() {
  if (!latestState) return;

  for (const button of mapControls.querySelectorAll("[data-map-id]")) {
    button.classList.toggle("selected", button.dataset.mapId === latestState.currentMapId);
  }
}

function updateItemsToggle() {
  if (!latestState) return;

  itemsToggle.classList.toggle("selected", latestState.itemsEnabled);
  itemsToggle.textContent = latestState.itemsEnabled ? "开启" : "关闭";
}

function getDefaultPlayerName() {
  return `Player${Math.floor(1000 + Math.random() * 9000)}`;
}

function trimText(text, maxLength) {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function getWeaponHudText(player) {
  if (!player || !latestState.weapons) return "-";

  const weapon = latestState.weapons[player.currentWeapon];
  const weaponState = player.weapons && player.weapons[player.currentWeapon];
  if (!weapon || !weaponState) return "-";

  const limitedDrop = weapon.dropOnly && latestState.gameMode !== "deathmatch";
  const status = limitedDrop
    ? `限定 ${weaponState.loaded}/${weapon.magazineSize}`
    : weaponState.reloadRemaining > 0
      ? "换弹中"
      : `${weaponState.loaded}/${weapon.magazineSize}`;
  return `${weapon.name} ${status}`;
}

function getAvailableWeaponSlots() {
  if (!latestState || !latestState.weapons) return baseWeaponSlots;

  const me = latestState.players[selfId];
  const allWeaponIds = Object.keys(latestState.weapons);
  const dropWeaponIds = allWeaponIds.filter((weaponId) => latestState.weapons[weaponId].dropOnly);
  const ownedDropWeaponIds = me && me.weapons
    ? dropWeaponIds.filter((weaponId) => Boolean(me.weapons[weaponId]))
    : [];

  if (latestState.gameMode === "deathmatch") {
    return [...baseWeaponSlots, ...dropWeaponIds].filter((weaponId) => latestState.weapons[weaponId]);
  }

  return [...baseWeaponSlots, ...ownedDropWeaponIds].filter((weaponId) => latestState.weapons[weaponId]);
}

function getWeaponShortcutHtml(player) {
  const weaponSlots = getAvailableWeaponSlots();
  return weaponSlots.map((weaponId, index) => {
    const weapon = latestState.weapons[weaponId];
    const owned = player && player.weapons && player.weapons[weaponId];
    const label = weapon.dropOnly && latestState.gameMode !== "deathmatch" && !owned
      ? `${weapon.name} 未拾取`
      : weapon.name;

    return `<div class="weapon-line"><span class="weapon-key">${index + 1}</span><span>${escapeHtml(label)}${weapon.dropOnly ? " · 空投" : ""}</span></div>`;
  }).join("");
}

function getWeaponStatusText(weapon, weaponState) {
  if (!weapon || !weaponState) return "-";
  if (weapon.dropOnly && latestState.gameMode !== "deathmatch") return "限定弹量";
  return weaponState.reloadRemaining > 0 ? `换弹中 ${formatTicks(weaponState.reloadRemaining)}s` : "可射击";
}

function getBuffStatusHtml(player) {
  if (!player || !player.buffs) return "";

  const lines = [];
  if (player.buffs.speedRemaining > 0) {
    lines.push(`<div class="player-line"><span>加速</span><span>${formatTicks(player.buffs.speedRemaining)}s</span></div>`);
  }
  if (player.buffs.shield > 0) {
    lines.push(`<div class="player-line"><span>护盾</span><span>${Math.ceil(player.buffs.shield)} / ${formatTicks(player.buffs.shieldRemaining)}s</span></div>`);
  }
  return lines.join("");
}

function getAmmoRatio(weaponState, weapon) {
  if (!weaponState || !weapon || weapon.magazineSize <= 0) return 0;
  return clamp(weaponState.loaded / weapon.magazineSize, 0, 1);
}

function formatTicks(ticks) {
  const tickRate = latestState && latestState.tickRate ? latestState.tickRate : 60;
  return (ticks / tickRate).toFixed(1);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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
