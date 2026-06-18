const socket = io();
const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");
const joinPanel = document.getElementById("joinPanel");
const gameControls = document.getElementById("gameControls");
const mapControls = document.getElementById("mapControls");
const statusPanel = document.getElementById("statusPanel");
const weaponStatus = document.getElementById("weaponStatus");
const playerStatusList = document.getElementById("playerStatusList");
const playerNameInput = document.getElementById("playerName");
const colorOptions = document.getElementById("colorOptions");

let selfId = null;
let latestState = null;
let mouseScreen = { x: 0, y: 0 };
let camera = { x: 0, y: 0 };
let moveMarkers = [];
let joinedGame = false;
let selectedColor = "#4cc9f0";

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
const weaponSlots = ["pistol", "smg", "shotgun", "sniper"];

socket.on("self", (id) => {
  selfId = id;
});

socket.on("state", (state) => {
  latestState = state;
  setupMapControls();
  updateModeButtons();
  updateMapButtons();
  updateStatusPanel();
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

window.addEventListener("keydown", (event) => {
  if (!joinedGame) return;

  const number = Number(event.key);
  if (number >= 1 && number <= weaponSlots.length) {
    socket.emit("switchWeapon", { weaponId: weaponSlots[number - 1] });
  }

  if (event.key.toLowerCase() === "r") {
    socket.emit("reload");
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

  drawPlayerName(player, screen.x, screen.y - player.radius - 22);
  drawHealthBar(player, screen.x, screen.y - player.radius - 14);
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
  const aliveCount = players.filter((player) => player.alive).length;
  const modeText = latestState.gameMode === "survival" ? "单场生存" : "死亡竞技";
  const mapText = latestState.maps && latestState.maps[latestState.currentMapId]
    ? latestState.maps[latestState.currentMapId].name
    : "-";
  const weaponText = getWeaponHudText(me);

  ctx.fillStyle = "rgba(0, 0, 0, 0.42)";
  ctx.fillRect(14, 14, 330, 182);

  ctx.fillStyle = "#f3f6fb";
  ctx.font = "16px Arial, sans-serif";
  ctx.fillText(`在线人数：${players.length}`, 28, 40);
  ctx.fillText(`我的血量：${hpText}`, 28, 64);
  ctx.fillText(`模式：${modeText}`, 28, 88);
  ctx.fillText(`地图：${mapText}`, 28, 112);
  ctx.fillText(`第 ${latestState.roundNumber || 1} 局，存活：${aliveCount}`, 28, 136);
  ctx.fillText(`武器：${weaponText}`, 28, 160);
  ctx.fillText("1-4 切枪，R 换弹", 28, 184);

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

function updateStatusPanel() {
  if (!latestState || !joinedGame) return;

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
  const reloadText = currentState && currentState.reloadRemaining > 0
    ? `换弹中 ${formatTicks(currentState.reloadRemaining)}s`
    : "可射击";

  weaponStatus.innerHTML = `
    <div class="weapon-title">
      <span>当前武器：${escapeHtml(currentWeapon ? currentWeapon.name : "-")}</span>
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
    <div class="bar">
      <div class="bar-fill" style="width: ${getAmmoRatio(currentState, currentWeapon) * 100}%; background: #7ee0ff;"></div>
    </div>
    <div class="weapon-line"><span class="weapon-key">1</span><span>手枪</span></div>
    <div class="weapon-line"><span class="weapon-key">2</span><span>冲锋枪</span></div>
    <div class="weapon-line"><span class="weapon-key">3</span><span>霰弹枪</span></div>
    <div class="weapon-line"><span class="weapon-key">4</span><span>狙击枪</span></div>
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
        <div class="player-line"><span>武器</span><span>${escapeHtml(weapon ? weapon.name : "-")}</span></div>
        <div class="player-line"><span>速度</span><span>${escapeHtml(speedText)}</span></div>
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

  const status = weaponState.reloadRemaining > 0 ? "换弹中" : `${weaponState.loaded}/${weapon.magazineSize}`;
  return `${weapon.name} ${status}`;
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
