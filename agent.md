请你帮我实现一个最小可运行的 2D 联机小游戏，玩法类似“圆点大战”。

核心需求：
1. 使用 HTML Canvas + JavaScript 绘制客户端画面。
2. 使用 Node.js + Express + Socket.IO 实现联机服务器。
3. 不使用任何复杂游戏引擎，不使用 Unity/Godot，不需要图片素材。
4. 画面只需要简单几何图形：
   - 玩家：圆点
   - 子弹：小圆点
   - 障碍物：矩形
   - 血量：玩家头顶血条
5. 操作方式：
   - 鼠标右键点击地图：控制角色向目标点移动，类似 LOL 的右键走位。
   - 鼠标左键点击地图：角色朝鼠标方向发射子弹。
   - 禁用浏览器默认右键菜单。
6. 客户端只负责输入和渲染。
7. 服务器负责权威逻辑：
   - 玩家位置更新
   - 子弹生成
   - 子弹移动
   - 子弹命中检测
   - 玩家扣血
   - 死亡与复活
   - 状态广播
8. 第一版不需要登录系统、不需要匹配系统、不需要数据库、不需要美术资源。
9. 目标是能够在本地运行，也方便以后部署到腾讯云服务器。

请按照下面的项目结构生成代码：

project/
  package.json
  server.js
  public/
    index.html
    client.js
    style.css

具体功能要求：

一、服务器 server.js
1. 使用 Express 托管 public 静态文件。
2. 使用 Socket.IO 处理玩家连接。
3. 当玩家连接时：
   - 创建一个玩家对象。
   - 随机出生在地图内。
   - 分配一个随机颜色。
   - 初始 hp = 100。
4. 当玩家断开连接时，删除该玩家。
5. 服务器维护：
   - players 对象
   - bullets 数组
   - obstacles 数组
6. 地图大小先设为：
   - width = 1600
   - height = 1000
7. 玩家属性包括：
   - id
   - x, y
   - targetX, targetY
   - radius
   - speed
   - hp
   - maxHp
   - color
   - alive
   - respawnTimer
8. 子弹属性包括：
   - id
   - ownerId
   - x, y
   - vx, vy
   - radius
   - damage
   - life
9. 玩家移动逻辑：
   - 如果玩家 alive，则每 tick 向 targetX, targetY 移动。
   - 接近目标点后停止。
   - 玩家不能走出地图边界。
   - 玩家不能穿过障碍物。
   - 第一版碰撞可以简单处理：如果下一步位置与障碍物碰撞，则不移动。
10. 射击逻辑：
   - 客户端发送 shoot 事件，包含 angle。
   - 服务器根据玩家当前位置和 angle 创建子弹。
   - 子弹速度固定，例如 10。
   - 子弹有生命周期，超时删除。
   - 死亡玩家不能射击。
11. 命中逻辑：
   - 子弹击中非 owner 的玩家时，扣血。
   - 子弹击中玩家后删除。
   - 子弹击中障碍物后删除。
   - hp <= 0 时，玩家死亡，alive = false。
   - 死亡后 3 秒自动复活，hp 恢复到 100，随机位置重生。
12. 服务器 tick：
   - 使用 setInterval，30 tick/s。
   - 每 tick 更新移动、子弹、碰撞、复活。
   - 每 tick 通过 io.emit("state", state) 广播完整状态。
13. 客户端发送的事件：
   - move: { x, y }
   - shoot: { angle }
14. 服务器广播的 state 包含：
   - players
   - bullets
   - obstacles
   - mapWidth
   - mapHeight

二、客户端 public/index.html
1. 页面包含一个 canvas。
2. 引入 Socket.IO 客户端脚本。
3. 引入 client.js 和 style.css。
4. 页面无复杂 UI，只需要显示游戏画面。

三、客户端 public/client.js
1. 连接服务器：
   - const socket = io();
2. 获取 canvas 和 ctx。
3. canvas 自动适应浏览器窗口大小。
4. 维护最新服务器状态 latestState。
5. 收到 state 后保存。
6. 渲染逻辑：
   - 使用 requestAnimationFrame 循环绘制。
   - 背景填充深色。
   - 根据自己的玩家位置做摄像机跟随。
   - 绘制地图边界。
   - 绘制障碍物。
   - 绘制所有玩家。
   - 绘制玩家血条。
   - 绘制死亡玩家为半透明或灰色。
   - 绘制所有子弹。
   - 绘制简单准星或鼠标位置提示。
7. 输入逻辑：
   - 禁用右键菜单。
   - 鼠标右键点击：把屏幕坐标转换成世界坐标，发送 move 事件。
   - 鼠标左键点击：根据自己玩家坐标和鼠标世界坐标计算 angle，发送 shoot 事件。
8. 要正确处理摄像机坐标：
   - screenToWorld()
   - worldToScreen()
9. 在画面左上角显示简单文字：
   - 当前在线人数
   - 自己的血量
   - 操作说明：右键移动，左键射击

四、public/style.css
1. 去掉 body margin。
2. 设置背景为黑色。
3. canvas 占满屏幕。
4. 禁止页面滚动。

五、package.json
1. 添加 start 命令：
   - "start": "node server.js"
2. 依赖：
   - express
   - socket.io

六、运行方式
请在 README 或输出说明中告诉我：
1. npm install
2. npm start
3. 浏览器打开 http://localhost:3000
4. 可以打开多个浏览器窗口测试多玩家联机。

七、代码质量要求
1. 代码尽量简单，便于初学者理解。
2. 所有核心逻辑都写注释。
3. 不要引入 TypeScript。
4. 不要使用构建工具。
5. 不要使用 webpack、vite、react、vue。
6. 保证复制代码后可以直接 npm install && npm start 运行。
7. 如果有必要，请将碰撞检测、距离计算等函数拆成小函数。

八、玩法细节
1. 玩家半径：18。
2. 玩家移动速度：4。
3. 子弹半径：5。
4. 子弹速度：12。
5. 子弹伤害：20。
6. 子弹生命周期：90 tick。
7. 地图中放置几个固定矩形障碍物，例如：
   - { x: 400, y: 300, w: 200, h: 80 }
   - { x: 900, y: 500, w: 100, h: 250 }
   - { x: 1200, y: 200, w: 250, h: 100 }
8. 玩家出生时不要出现在障碍物内部。
9. 子弹和玩家都不能穿过障碍物。
10. 服务器需要做基本输入校验，防止客户端发送非法坐标或非法 angle。

请你直接生成完整项目代码，并确保最终版本可以运行。