# Tencent Cloud Copy Deploy

This project does not need a build step. After copying the whole project folder to your Tencent Cloud server, run this command inside the project directory:

```bash
bash deploy.sh
```

The script will:

- install production dependencies with `npm ci --omit=dev`
- install `pm2` if it is missing
- start the app with pm2 on the first run
- restart the existing pm2 app on later runs
- save the pm2 process list

Default settings:

```bash
APP_NAME=shooting
PORT=3000
```

Use another port:

```bash
PORT=8080 bash deploy.sh
```

Use another pm2 app name:

```bash
APP_NAME=shooting-test PORT=8080 bash deploy.sh
```

Common commands:

```bash
pm2 status shooting
pm2 logs shooting
pm2 restart shooting --update-env
pm2 stop shooting
```

To restore pm2 apps automatically after a server reboot, run this once after a successful deploy:

```bash
pm2 startup
```

Then copy and run the command printed by pm2.
