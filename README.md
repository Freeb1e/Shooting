# Circle Battle

一个最小可运行的 2D 联机圆点大战小游戏，使用 HTML Canvas、Node.js、Express 和 Socket.IO。

## 运行方式

```bash
npm install
npm start
```

然后在浏览器打开：

```text
http://localhost:3000
```

可以打开多个浏览器窗口测试多玩家联机。

## 操作

- 右键点击地图：移动
- 左键点击地图：射击

服务器负责玩家移动、子弹生成、碰撞、扣血、死亡复活和状态广播；客户端只负责输入和渲染。
