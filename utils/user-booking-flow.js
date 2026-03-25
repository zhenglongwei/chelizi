/**
 * 预约到店流程：与维修厂详情「立即预约」一致，供详情页与「我的」等复用
 */
const navigation = require('./navigation');
const ui = require('./ui');
const { getToken } = require('./api');

function mergeBookingLists(data) {
  const po = data.product_orders || [];
  const ro = data.repair_orders || [];
  return [
    ...po.map((x) => ({ ...x, _t: 'po' })),
    ...ro.map((x) => ({ ...x, _t: 'ro' }))
  ];
}

/**
 * @param {object} opts
 * @param {'shop'|'global'} opts.context
 * @param {string} [opts.shopId] - shop 场景必填
 * @param {() => Promise<{ product_orders: any[], repair_orders: any[] }>} opts.fetchBookingOptions
 * @param {() => any[]} [opts.getShopProducts] - shop 场景，无单时「购买标品」用
 * @param {string} [opts.loginRedirect] - 未登录时回跳
 */
async function runUserBookingFlow(opts) {
  const { context, shopId, fetchBookingOptions, getShopProducts, loginRedirect } = opts;
  if (!getToken()) {
    const redir =
      loginRedirect ||
      (context === 'shop' && shopId
        ? '/pages/shop/detail/index?id=' + encodeURIComponent(shopId)
        : '/pages/user/index/index');
    navigation.navigateTo('/pages/auth/login/index', { redirect: redir });
    return;
  }

  let data;
  try {
    data = await fetchBookingOptions();
  } catch (e) {
    ui.showError((e && e.message) || '查询失败，请稍后重试');
    return;
  }

  const all = mergeBookingLists(data);

  if (all.length === 0) {
    if (context === 'shop' && shopId) {
      wx.showModal({
        title: '暂时无法直接预约',
        content:
          '您在本店还没有已付款的标品订单，也没有维修厂已接单的维修单。可先购买本店标品并完成支付，或发起竞价维修、选好维修厂后再预约。',
        confirmText: '购买标品',
        cancelText: '竞价维修',
        success: (r) => {
          if (r.confirm) {
            const prods = (getShopProducts && getShopProducts()) || [];
            if (prods[0]) {
              navigation.navigateTo('/pages/shop/product/confirm/index', {
                shop_id: shopId,
                product_id: prods[0].product_id
              });
            } else {
              ui.showWarning('本店暂无上架标品，您可先发起竞价维修');
              navigation.navigateTo('/pages/damage/upload/index');
            }
          } else if (r.cancel) {
            navigation.navigateTo('/pages/damage/upload/index');
          }
        }
      });
    } else {
      wx.showModal({
        title: '暂时无法预约',
        content:
          '您当前没有可用于预约的订单（需某店已付款的标品，或该店维修中/待确认的维修单）。可先发起竞价并选择维修厂，或进入维修厂详情购买标品后再点预约。',
        confirmText: '逛逛首页',
        cancelText: '竞价维修',
        success: (r) => {
          if (r.confirm) {
            navigation.switchTab('/pages/index/index');
          } else if (r.cancel) {
            navigation.navigateTo('/pages/damage/upload/index');
          }
        }
      });
    }
    return;
  }

  function goBook(sid, x) {
    if (x._t === 'po') {
      navigation.navigateTo('/pages/shop/book/index', { id: sid, product_order_id: x.product_order_id });
    } else {
      navigation.navigateTo('/pages/shop/book/index', { id: sid, order_id: x.order_id });
    }
  }

  if (all.length === 1) {
    const x = all[0];
    const sid = x.shop_id || shopId;
    goBook(sid, x);
    return;
  }

  if (all.length > 6) {
    wx.showModal({
      title: '可预约的订单较多',
      content: '请打开「我的订单」，在列表里进入对应标品或维修单后再预约到店。',
      confirmText: '去我的订单',
      cancelText: '知道了',
      success: (r) => {
        if (r.confirm) navigation.navigateTo('/pages/order/hub/index');
      }
    });
    return;
  }

  wx.showActionSheet({
    itemList: all.map((x) => x.sheet_title || (x._t === 'po' ? x.product_name : '维修单')),
    success: (res) => {
      const x = all[res.tapIndex];
      if (!x) return;
      const sid = x.shop_id || shopId;
      goBook(sid, x);
    }
  });
}

module.exports = {
  runUserBookingFlow
};
