/**
 * pm2 process manager config.
 *
 * Usage on VPS:
 *   pm2 start ecosystem.config.cjs
 *   pm2 save && pm2 startup       # auto-start on reboot
 *   pm2 logs hft-elon-bot         # live tail
 *   pm2 monit                     # ncurses dashboard
 *
 * Why pm2:
 *   - auto-restart on crash (we DO want this; uncaughtException is logged but
 *     a process kill from OOM still benefits from restart)
 *   - log rotation built-in (no growing /tmp/*.log)
 *   - works the same on Mac dev and Ubuntu VPS
 *   - `pm2 startup` integrates with systemd transparently
 */

module.exports = {
  apps: [
    {
      name: 'hft-elon-bot',
      script: 'src/index.ts',
      interpreter: './node_modules/.bin/tsx',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
      },

      // Restart policy
      autorestart: true,
      max_restarts: 10,
      min_uptime: 30_000,      // crash within 30s? treat as failed
      restart_delay: 5_000,    // wait 5s between restarts
      kill_timeout: 5_000,     // give SIGTERM 5s before SIGKILL

      // Resource limits
      max_memory_restart: '500M',   // restart if RSS > 500MB

      // Logs
      out_file: './data/logs/out.log',
      error_file: './data/logs/err.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      time: true,

      // Disable pm2's internal log rotation in favor of standard pino-pretty
      log_type: 'raw',
    },
  ],
};
