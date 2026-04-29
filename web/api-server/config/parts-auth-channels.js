/**
 * 配件验真渠道模板（可运营扩展）
 * 说明：
 * - key 为标准品牌标识
 * - url_template 支持 {part_code} 占位
 */

const BRAND_CHANNEL_TEMPLATES = Object.freeze({
  toyota: { name: '丰田官方渠道', url_template: 'https://www.toyota.com.cn/search?keyword={part_code}' },
  bmw: { name: '宝马官方渠道', url_template: 'https://www.bmw.com.cn/zh/search.html?query={part_code}' },
  mercedes: { name: '奔驰官方渠道', url_template: 'https://www.mercedes-benz.com.cn/search?query={part_code}' },
  volkswagen: { name: '大众官方渠道', url_template: 'https://www.vw.com.cn/search?query={part_code}' },
  honda: { name: '本田官方渠道', url_template: 'https://www.honda.com.cn/search?query={part_code}' },
  byd: { name: '比亚迪官方渠道', url_template: 'https://www.byd.com/cn/search?query={part_code}' },
});

const BRAND_ALIASES = Object.freeze({
  丰田: 'toyota',
  toyota: 'toyota',
  宝马: 'bmw',
  bmw: 'bmw',
  奔驰: 'mercedes',
  benz: 'mercedes',
  mercedes: 'mercedes',
  大众: 'volkswagen',
  vw: 'volkswagen',
  volkswagen: 'volkswagen',
  本田: 'honda',
  honda: 'honda',
  比亚迪: 'byd',
  byd: 'byd',
});

module.exports = {
  BRAND_CHANNEL_TEMPLATES,
  BRAND_ALIASES,
};

