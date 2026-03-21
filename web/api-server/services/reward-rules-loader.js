/**
 * 奖励金规则加载器
 * 从 reward_rules 表读取配置，为唯一数据源。配置缺失时直接报错。
 */

const CONFIG_KEY = 'rewardRules';

/**
 * 从 reward_rules 表读取完整奖励金配置
 * @param {object} pool - 数据库连接池
 * @returns {Promise<object>} rewardRules 配置对象
 * @throws {Error} 配置缺失或无效时抛出
 */
async function getRewardRulesConfig(pool) {
  const [rows] = await pool.execute(
    "SELECT rule_value FROM reward_rules WHERE rule_key = ?",
    [CONFIG_KEY]
  );
  if (!rows || rows.length === 0) {
    throw new Error('奖励金规则未配置，请在运营后台 /admin/reward-rules 完成配置');
  }
  const raw = rows[0].rule_value;
  let config;
  try {
    config = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    throw new Error('奖励金规则配置格式错误：' + (e.message || 'JSON 解析失败'));
  }
  if (!config || typeof config !== 'object') {
    throw new Error('奖励金规则配置无效');
  }
  return config;
}

/**
 * 从 reward_rules 获取 complexityLevels 数组（用于匹配与计算）
 * @param {object} pool - 数据库连接池
 * @returns {Promise<Array>} [{ level, project_type, fixed_reward, float_ratio, cap_amount }, ...]
 */
async function getComplexityLevels(pool) {
  const config = await getRewardRulesConfig(pool);
  const levels = config.complexityLevels;
  if (!Array.isArray(levels) || levels.length === 0) {
    throw new Error('奖励金规则中缺少 complexityLevels 配置，请在运营后台模块1完成配置');
  }
  return levels;
}

module.exports = {
  getRewardRulesConfig,
  getComplexityLevels,
};
