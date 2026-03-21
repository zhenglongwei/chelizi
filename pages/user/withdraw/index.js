// pages/user/withdraw/index.js
const {
  getToken,
  getUserProfile,
  withdraw,
  withdrawReconcile,
  withdrawCancelPending,
} = require('../../../utils/api');
const { getNavBarHeight } = require('../../../utils/util');

/** 与后端 WECHAT_TRANSFER_NAME_FEN_MIN 默认 200000（2000 元）一致：达到该金额才必填并加密姓名 */
const NAME_THRESHOLD_YUAN = 2000;

Page({
  data: {
    balance: '0.00',
    amount: '',
    realName: '',
    showRealName: false,
    loading: false,
    pageRootStyle: 'padding-top: 88px',
  },

  onLoad() {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px' });
    if (!getToken()) {
      wx.navigateTo({ url: '/pages/auth/login/index?redirect=' + encodeURIComponent('/pages/user/withdraw/index') });
      return;
    }
    this.loadBalance();
  },

  async loadBalance() {
    try {
      const p = await getUserProfile();
      const b = p && p.balance != null ? Number(p.balance).toFixed(2) : '0.00';
      const rn = (p && p.withdraw_real_name) || '';
      this.setData({ balance: b, realName: rn });
    } catch (e) {
      console.error(e);
    }
  },

  onAmountInput(e) {
    const v = e.detail.value;
    const amt = parseFloat(v || '0');
    this.setData({
      amount: v,
      showRealName: Number.isFinite(amt) && amt >= NAME_THRESHOLD_YUAN,
    });
  },

  onRealNameInput(e) {
    this.setData({ realName: e.detail.value });
  },

  onWithdrawAll() {
    const bal = parseFloat(this.data.balance || '0');
    this.setData({
      amount: this.data.balance,
      showRealName: Number.isFinite(bal) && bal >= NAME_THRESHOLD_YUAN,
    });
  },

  requestWechatTransfer(payload) {
    return new Promise((resolve, reject) => {
      if (!wx.requestMerchantTransfer) {
        reject(new Error('当前微信版本过低，请升级后重试'));
        return;
      }
      const MS = 25000;
      const timer = setTimeout(() => {
        reject(new Error('拉起微信确认页超时（模拟器常不支持，请用真机调试）'));
      }, MS);
      const done = (fn, arg) => {
        clearTimeout(timer);
        fn(arg);
      };
      const opt = {
        mchId: String(payload.mch_id || ''),
        appId: String(payload.app_id || ''),
        package: String(payload.package_info || ''),
        success: (res) => done(resolve, res),
        fail: (err) => done(reject, err || new Error('拉起确认收款失败')),
      };
      if (payload.openid) {
        opt.openId = String(payload.openid);
      }
      try {
        wx.requestMerchantTransfer(opt);
      } catch (e) {
        clearTimeout(timer);
        reject(e || new Error('无法调起商家转账'));
      }
    });
  },

  async openWechatPackage(data) {
    try {
      await this.requestWechatTransfer(data);
      return true;
    } catch (_) {
      const rec = await withdrawReconcile({ withdraw_id: data.withdraw_id }).catch(() => null);
      if (rec && rec.can_request_transfer && rec.package_info) {
        try {
          await this.requestWechatTransfer({
            mch_id: rec.mch_id,
            app_id: rec.app_id,
            package_info: rec.package_info,
            openid: rec.openid,
          });
          return true;
        } catch (_) {}
      }
    }
    return false;
  },

  async onCancelPending() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      const r = await withdrawCancelPending({});
      wx.showToast({
        title: r.ok ? '已提交撤销' : r.message || '请稍后重试',
        icon: 'none',
        duration: 2500,
      });
      await this.loadBalance();
    } catch (e) {
      wx.showToast({ title: e.message || '操作失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  async onSubmit() {
    const amount = parseFloat(this.data.amount || '0');
    const balance = parseFloat(this.data.balance || '0');
    const name = (this.data.realName || '').trim();
    const needRealName = amount >= NAME_THRESHOLD_YUAN;
    if (!Number.isFinite(amount) || amount <= 0) {
      wx.showToast({ title: '请输入大于0的金额', icon: 'none' });
      return;
    }
    if (amount > balance) {
      wx.showToast({ title: '余额不足', icon: 'none' });
      return;
    }
    if (needRealName && !name) {
      wx.showToast({ title: '单笔≥2000元需填写真实姓名', icon: 'none' });
      return;
    }
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      wx.showLoading({ title: '处理中…', mask: true });
      const data = await withdraw({
        amount,
        real_name: name,
      });
      wx.hideLoading();

      if (data && data.transfer_mode === 'wechat') {
        if (data.warning === 'no_package') {
          wx.showModal({
            title: '待确认提现',
            content: data.hint || '领取会话已失效，请先取消待确认提现后再发起',
            confirmText: '取消待确认',
            cancelText: '关闭',
            success: (sm) => {
              if (sm.confirm) this.onCancelPending();
            },
          });
          return;
        }
        if (data.action === 'resume_pending' && data.amount != null) {
          wx.showToast({
            title: '请先完成上一笔 ¥' + Number(data.amount).toFixed(2) + ' 的微信确认',
            icon: 'none',
            duration: 2200,
          });
        }
        if (data.package_info) {
          wx.showLoading({ title: '正在打开微信…', mask: true });
          let opened = false;
          try {
            opened = await this.openWechatPackage(data);
          } finally {
            wx.hideLoading();
          }
          if (opened) {
            wx.showToast({ title: '请在微信内确认收款', icon: 'success' });
            setTimeout(() => wx.navigateBack(), 1600);
            return;
          }
          wx.showModal({
            title: '未能打开确认页',
            content: '模拟器通常无法调起商家转账，请使用真机；或点「取消待确认提现」后重试。',
            confirmText: '取消待确认',
            cancelText: '关闭',
            success: (sm) => {
              if (sm.confirm) this.onCancelPending();
            },
          });
          return;
        }
      }

      wx.showToast({ title: '提现申请已提交', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 1500);
    } catch (e) {
      wx.hideLoading();
      if (!(e && e.statusCode === 401)) {
        wx.showToast({ title: e.message || '提现失败', icon: 'none', duration: 3000 });
      }
    } finally {
      this.setData({ loading: false });
    }
  },
});
