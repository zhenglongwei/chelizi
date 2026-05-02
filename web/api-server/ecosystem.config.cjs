/**
 * PM2 ecosystem for 辙见 API（生产/测试可复用）
 *
 * 目标：
 * - 固定 cwd 到 api-server 目录，避免 process.cwd() 相关相对路径读取异常
 * - 与线上目录结构 `/var/www/simplewin/web/api-server` 对齐
 */

const path = require('path');

module.exports = {
  apps: [
    {
      name: 'zhejian-api',
      script: 'server.js',
      cwd: __dirname,
      exec_mode: 'cluster',
      // 保持与当前线上一致（你们现在是 cluster_mode 且有 0/1 两个实例）
      instances: 2,
      time: true,
      // 若你们希望 PM2 自己加载 env，可在服务器把 env 文件放到这里并取消注释：
      // env_file: '/var/www/simplewin/web/.env',
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'zhejian-damage-worker',
      script: path.join(__dirname, '..', 'scripts', 'run-damage-analysis-worker.js'),
      args: '--loop',
      cwd: path.join(__dirname, '..'),
      exec_mode: 'fork',
      instances: 1,
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};

