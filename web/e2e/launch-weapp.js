/**
 * Windows 下 Node 18.20+ 无法直接 spawn .bat，需通过 cmd 或 shell 启动。
 * 此模块手动启动 CLI 后由 automator.connect 连接。
 */
const { spawn } = require('child_process');
const path = require('path');

const CLI_PATH = process.env.WEAPP_CLI_PATH || 'C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat';
const PROJECT_PATH = process.env.WEAPP_PROJECT_PATH || 'C:\\Users\\longwei\\WeChatProjects\\chelizi';
const AUTO_PORT = parseInt(process.env.WEAPP_AUTO_PORT || '9420', 10);

function launchWeapp() {
  return new Promise((resolve, reject) => {
    const projectPath = path.resolve(PROJECT_PATH);
    const opts = { stdio: 'ignore', detached: true, shell: true };
    const cmd =
      process.platform === 'win32'
        ? `"${CLI_PATH}" auto --project "${projectPath}" --auto-port ${AUTO_PORT}`
        : `${CLI_PATH} auto --project ${projectPath} --auto-port ${AUTO_PORT}`;

    const proc = spawn(cmd, [], opts);
    proc.on('error', reject);
    proc.unref();
    resolve();
  });
}

module.exports = { launchWeapp, AUTO_PORT, CLI_PATH, PROJECT_PATH };
