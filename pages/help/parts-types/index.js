// 报价与配件说明（车主向）— 五类配件与《配件类型和极简证明材料》名称一致
const { getNavBarHeight, getSystemInfo } = require('../../../utils/util');

const PART_ORDER = ['原厂件', '同质品牌件', '普通副厂件', '再制造件', '回用拆车件'];

const PART_BLOCKS = [
  {
    name: '原厂件',
    summary: '与车辆品牌官方售后体系一致、可标注原厂零件号的配件，含 4S 常见纯正件等。',
    more: '新车装车同源或官方认证配件；若维修厂承诺使用原厂件，完工后可通过包装标识、零件号等核对（详见平台对服务商的证明材料要求）。'
  },
  {
    name: '同质品牌件',
    summary: '第三方正规品牌，质量与性能对标原厂、可合法替代使用的配件。',
    more: '又称「配套品牌件」等；价格通常低于原厂件，适合在意性价比又希望品质可靠的车主。'
  },
  {
    name: '普通副厂件',
    summary: '符合国家强制安全标准、有品牌与合格证的平价副厂配件，市场流通量大。',
    more: '不强调对标原厂档次，但须合规；适合预算有限、接受平价替代的场景。'
  },
  {
    name: '再制造件',
    summary: '以旧件为毛坯、经规范再制造并检测达标的产品，非简单翻新。',
    more: '部分总成类配件常见；环保且价格常低于全新原厂件，性能按规范应达到要求。'
  },
  {
    name: '回用拆车件',
    summary: '从正规报废车拆解、仅做清洁与检测的功能完好二手原厂件（俗称拆车件）。',
    more: '本质是二手原厂件，价格相对低；成色与寿命因件而异，下单前可与维修厂确认。'
  }
];

Page({
  data: {
    pageRootStyle: 'padding-top: 88px',
    scrollViewStyle: 'height: 600px',
    scrollIntoView: '',
    partBlocks: PART_BLOCKS,
    expandedFlags: [false, false, false, false, false],
    highlightIndex: -1,
    prequoteHighlight: false
  },

  onLoad(options) {
    const navH = getNavBarHeight();
    const sys = getSystemInfo();
    const rawType = options.type ? decodeURIComponent(options.type) : '';
    const highlightIndex = PART_ORDER.indexOf(rawType);
    const prequoteHighlight = options.section === 'prequote';

    this.setData({
      pageRootStyle: 'padding-top: ' + navH + 'px',
      scrollViewStyle: 'height: ' + (sys.windowHeight - navH) + 'px',
      highlightIndex,
      prequoteHighlight
    });

    const target =
      prequoteHighlight ? 'help-prequote' : highlightIndex >= 0 ? 'help-part-' + highlightIndex : '';
    if (target) {
      setTimeout(() => {
        this.setData({ scrollIntoView: target });
        setTimeout(() => this.setData({ scrollIntoView: '' }), 400);
      }, 200);
    }
  },

  toggleMore(e) {
    const idx = Number(e.currentTarget.dataset.index);
    if (idx < 0 || idx >= PART_BLOCKS.length) return;
    const flags = (this.data.expandedFlags || []).slice();
    flags[idx] = !flags[idx];
    this.setData({ expandedFlags: flags });
  }
});
