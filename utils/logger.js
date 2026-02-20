/**
 * 统一日志工具
 * 格式：[模块名] [级别] 消息
 * 不得直接使用 console.log/error/warn
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let globalLevel = LEVELS.info;

function log(module, level, ...args) {
  const levelNum = LEVELS[level] ?? LEVELS.info;
  if (levelNum < globalLevel) return;
  const prefix = `[${module}] [${level.toUpperCase()}]`;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn.apply(console, [prefix, ...args]);
}

function getLogger(module) {
  return {
    debug: (...args) => log(module, 'debug', ...args),
    info: (...args) => log(module, 'info', ...args),
    warn: (...args) => log(module, 'warn', ...args),
    error: (...args) => log(module, 'error', ...args)
  };
}

module.exports = { getLogger, LEVELS };
