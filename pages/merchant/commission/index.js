// 服务商佣金钱包 / 微信支付 / 明细
const ui = require('../../../utils/ui');
const {
  getMerchantToken,
  getMerchantCommissionWallet,
  putMerchantCommissionDeductMode,
  getMerchantCommissionLedger,
  getMerchantShopIncomeLedger,
  merchantShopIncomeWithdraw,
  merchantShopIncomeWithdrawReconcile,
  merchantShopIncomeWithdrawCancel,
  merchantShopIncomeCorpWithdraw,
  getMerchantShopIncomeCorpWithdrawals,
  merchantShopIncomeCorpWithdrawCancel,
  merchantCommissionRechargePrepay,
  merchantCommissionPayOrderPrepay,
  merchantCommissionFinalize,
  merchantCommissionRefund,
  getMerchantOrders,
  merchantUploadImage,
} = require('../../../utils/api');

const INCOME_NAME_THRESHOLD_YUAN = 2000;
const { getNavBarHeight } = require('../../../utils/util');
const { requestMerchantSubscribe } = require('../../../utils/subscribe');

function isMerchant401(err) {
  return !!(err && err.statusCode === 401);
}

function fmtMoney(n) {
  const x = parseFloat(n);
  if (Number.isNaN(x)) return '0.00';
  return x.toFixed(2);
}

Page({
  data: {
    pageRootStyle: '',
    walletBalance: '0.00',
    walletFrozen: '0.00',
    incomeBalance: '0.00',
    incomeFrozen: '0.00',
    modeLabel: '自动扣余额',
    deductMode: 'auto',
    ledger: [],
    incomeLedger: [],
    pendingOrders: [],
    rechargeAmount: '500',
    refundAmount: '',
    finalizeOrderId: '',
    finalizeAmount: '',
    proofUrls: [],
    incomeWithdrawAmount: '',
    incomeRealName: '',
    showIncomeRealName: false,
    incomeWithdrawLoading: false,
    incomeWithdrawMode: 'wechat',
    corpCompanyName: '',
    corpBankName: '',
    corpBankAccount: '',
    corpBankBranch: '',
    corpContactName: '',
    corpContactPhone: '',
    corpRemark: '',
    incomeCorpList: [],
    showCommissionHelp: false,
    deductModeSaving: false,
    activeAccountTab: 'commission',
    showRefundBlock: false,
    showFinalizeBlock: false,
    incomeSubTab: 'withdraw',
  },

  onAccountTabTap(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === 'commission' || tab === 'income') this.setData({ activeAccountTab: tab });
  },

  toggleRefundBlock() {
    this.setData({ showRefundBlock: !this.data.showRefundBlock });
  },

  toggleFinalizeBlock() {
    this.setData({ showFinalizeBlock: !this.data.showFinalizeBlock });
  },

  onIncomeSubTabTap(e) {
    const sub = e.currentTarget.dataset.subtab;
    if (sub === 'withdraw' || sub === 'corp' || sub === 'ledger') this.setData({ incomeSubTab: sub });
  },

  toggleCommissionHelp() {
    this.setData({ showCommissionHelp: !this.data.showCommissionHelp });
  },

  onLoad() {
    this.setData({ pageRootStyle: 'padding-top: ' + getNavBarHeight() + 'px' });
  },

  onShow() {
    if (!getMerchantToken()) {
      wx.redirectTo({
        url: '/pages/merchant/login?redirect=' + encodeURIComponent('/pages/merchant/commission/index'),
      });
      return;
    }
    requestMerchantSubscribe('commission_alert');
    this.refreshAll();
  },

  async refreshAll() {
    try {
      await Promise.all([
        this.loadWallet(),
        this.loadLedger(),
        this.loadIncomeLedger(),
        this.loadIncomeCorpList(),
        this.loadPendingOrders(),
      ]);
    } catch (e) {
      ui.showError(e.message || '加载失败');
    }
  },

  async loadWallet() {
    const w = await getMerchantCommissionWallet();
    const mode = w.deduct_mode || 'auto';
    this.setData({
      walletBalance: fmtMoney(w.balance),
      walletFrozen: fmtMoney(w.frozen),
      incomeBalance: fmtMoney(w.income_balance != null ? w.income_balance : 0),
      incomeFrozen: fmtMoney(w.income_frozen != null ? w.income_frozen : 0),
      deductMode: mode,
      modeLabel: mode === 'per_order' ? '逐单微信支付' : '自动扣余额',
    });
  },

  async loadLedger() {
    const res = await getMerchantCommissionLedger({ page: 1, limit: 30 });
    const list = (res.list || []).map((r) => ({
      ...r,
      created_at: r.created_at ? String(r.created_at).slice(0, 19) : '',
    }));
    this.setData({ ledger: list });
  },

  corpStatusLabel(st) {
    const m = { 0: '待财务打款', 1: '已完成', 2: '已驳回', 3: '已撤销' };
    return m[st] != null ? m[st] : String(st);
  },

  async loadIncomeCorpList() {
    try {
      const res = await getMerchantShopIncomeCorpWithdrawals({ page: 1, limit: 20 });
      const list = (res.list || []).map((r) => ({
        ...r,
        status_label: this.corpStatusLabel(r.status),
        created_at: r.created_at ? String(r.created_at).slice(0, 19) : '',
      }));
      this.setData({ incomeCorpList: list });
    } catch (_) {
      this.setData({ incomeCorpList: [] });
    }
  },

  onIncomeWithdrawModeChange(e) {
    const v = e.detail && e.detail.value;
    if (v === 'wechat' || v === 'corp') this.setData({ incomeWithdrawMode: v });
  },

  onCorpFieldInput(e) {
    const field = e.currentTarget.dataset.field;
    if (!field) return;
    this.setData({ [field]: e.detail.value });
  },

  async onCorpWithdrawSubmit() {
    if (this.data.incomeWithdrawLoading) return;
    const amt = parseFloat(this.data.incomeWithdrawAmount || '0');
    if (!Number.isFinite(amt) || amt <= 0) {
      ui.showError('请输入提现金额');
      return;
    }
    const bal = parseFloat(this.data.incomeBalance || '0');
    if (amt > bal + 1e-6) {
      ui.showError('可提现余额不足');
      return;
    }
    const company_name = (this.data.corpCompanyName || '').trim();
    const bank_name = (this.data.corpBankName || '').trim();
    const bank_account_no = (this.data.corpBankAccount || '').replace(/\s/g, '');
    if (company_name.length < 2) {
      ui.showError('请填写对公户名');
      return;
    }
    if (bank_name.length < 2) {
      ui.showError('请填写开户银行');
      return;
    }
    if (bank_account_no.length < 6) {
      ui.showError('请填写银行账号');
      return;
    }
    this.setData({ incomeWithdrawLoading: true });
    try {
      await merchantShopIncomeCorpWithdraw({
        amount: amt,
        company_name,
        bank_name,
        bank_account_no,
        bank_branch: (this.data.corpBankBranch || '').trim() || undefined,
        contact_name: (this.data.corpContactName || '').trim() || undefined,
        contact_phone: (this.data.corpContactPhone || '').trim() || undefined,
        merchant_remark: (this.data.corpRemark || '').trim() || undefined,
      });
      wx.showToast({ title: '已提交申请', icon: 'success' });
      this.setData({
        incomeWithdrawAmount: '',
        corpCompanyName: '',
        corpBankName: '',
        corpBankAccount: '',
        corpBankBranch: '',
        corpContactName: '',
        corpContactPhone: '',
        corpRemark: '',
      });
      await this.refreshAll();
    } catch (err) {
      if (!isMerchant401(err)) ui.showError(err.message || '提交失败');
    } finally {
      this.setData({ incomeWithdrawLoading: false });
    }
  },

  async onCancelCorpWithdraw() {
    if (this.data.incomeWithdrawLoading) return;
    this.setData({ incomeWithdrawLoading: true });
    try {
      await merchantShopIncomeCorpWithdrawCancel({});
      wx.showToast({ title: '已撤销', icon: 'success' });
      await this.refreshAll();
    } catch (err) {
      if (!isMerchant401(err)) ui.showError(err.message || '撤销失败');
    } finally {
      this.setData({ incomeWithdrawLoading: false });
    }
  },

  incomeLedgerTypeLabel(t) {
    const m = {
      product_order_settle: '标品入账',
      repair_order_settle: '维修款入账（车主已付）',
      withdraw_payout: '提现成功',
      withdraw_refund: '提现退回',
    };
    return m[t] || t || '';
  },

  async loadIncomeLedger() {
    const res = await getMerchantShopIncomeLedger({ page: 1, limit: 30 });
    const list = (res.list || []).map((r) => ({
      ...r,
      type_label: this.incomeLedgerTypeLabel(r.type),
      created_at: r.created_at ? String(r.created_at).slice(0, 19) : '',
    }));
    this.setData({ incomeLedger: list });
  },

  onIncomeWithdrawInput(e) {
    const v = e.detail.value;
    const amt = parseFloat(v || '0');
    this.setData({
      incomeWithdrawAmount: v,
      showIncomeRealName: Number.isFinite(amt) && amt >= INCOME_NAME_THRESHOLD_YUAN,
    });
  },

  onIncomeRealNameInput(e) {
    this.setData({ incomeRealName: e.detail.value });
  },

  onIncomeWithdrawAll() {
    const bal = parseFloat(this.data.incomeBalance || '0');
    this.setData({
      incomeWithdrawAmount: this.data.incomeBalance,
      showIncomeRealName: Number.isFinite(bal) && bal >= INCOME_NAME_THRESHOLD_YUAN,
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
        reject(new Error('拉起微信确认页超时（请用真机调试）'));
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
      if (payload.openid) opt.openId = String(payload.openid);
      try {
        wx.requestMerchantTransfer(opt);
      } catch (e) {
        clearTimeout(timer);
        reject(e || new Error('无法调起商家转账'));
      }
    });
  },

  async openIncomeWechatPackage(data) {
    try {
      await this.requestWechatTransfer(data);
      return true;
    } catch (_) {
      const rec = await merchantShopIncomeWithdrawReconcile({ withdraw_id: data.withdraw_id }).catch(() => null);
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

  async onCancelIncomeWithdraw() {
    if (this.data.incomeWithdrawLoading) return;
    this.setData({ incomeWithdrawLoading: true });
    try {
      await merchantShopIncomeWithdrawCancel({});
      wx.showToast({ title: '已处理', icon: 'success' });
      await this.refreshAll();
    } catch (err) {
      if (!isMerchant401(err)) ui.showError(err.message || '失败');
    } finally {
      this.setData({ incomeWithdrawLoading: false });
    }
  },

  async onIncomeWithdraw() {
    if (this.data.incomeWithdrawLoading) return;
    const amt = parseFloat(this.data.incomeWithdrawAmount || '0');
    if (!Number.isFinite(amt) || amt <= 0) {
      ui.showError('请输入提现金额');
      return;
    }
    const bal = parseFloat(this.data.incomeBalance || '0');
    if (amt > bal + 1e-6) {
      ui.showError('可提现余额不足');
      return;
    }
    const body = { amount: amt };
    if (this.data.showIncomeRealName) {
      const rn = (this.data.incomeRealName || '').trim();
      if (rn.length < 2) {
        ui.showError('单笔≥2000元需填写与微信实名一致的姓名');
        return;
      }
      body.real_name = rn;
    }
    this.setData({ incomeWithdrawLoading: true });
    try {
      const res = await merchantShopIncomeWithdraw(body);
      const ok = await this.openIncomeWechatPackage({
        withdraw_id: res.withdraw_id,
        mch_id: res.mch_id,
        app_id: res.app_id,
        package_info: res.package_info,
        openid: res.openid,
      });
      if (ok) wx.showToast({ title: '请在微信中确认收款', icon: 'none' });
      this.setData({ incomeWithdrawAmount: '', incomeRealName: '', showIncomeRealName: false });
      await this.refreshAll();
    } catch (err) {
      if (err.statusCode === 409) {
        ui.showError(err.message || '存在处理中的提现');
      } else if (!isMerchant401(err)) {
        ui.showError(err.message || '提现失败');
      }
    } finally {
      this.setData({ incomeWithdrawLoading: false });
    }
  },

  async loadPendingOrders() {
    const res = await getMerchantOrders({ status: 3, limit: 30, page: 1 });
    const list = (res.list || []).filter((o) => {
      if (o.commission_status === 'pending_owner_repair_pay') return false;
      return ['awaiting_pay', 'arrears'].includes(o.commission_status);
    });
    const pending = list.map((o) => {
      const due = parseFloat(o.commission_final) || parseFloat(o.commission_provisional) || 0;
      const paid = parseFloat(o.commission_paid_amount) || 0;
      const need = Math.round((due - paid) * 100) / 100;
      return { ...o, needPay: fmtMoney(need) };
    });
    this.setData({ pendingOrders: pending });
  },

  onRechargeInput(e) {
    this.setData({ rechargeAmount: e.detail.value });
  },

  onRefundInput(e) {
    this.setData({ refundAmount: e.detail.value });
  },

  onFinOrderInput(e) {
    this.setData({ finalizeOrderId: e.detail.value });
  },

  onFinAmtInput(e) {
    this.setData({ finalizeAmount: e.detail.value });
  },

  async onDeductModeChange(e) {
    if (this.data.deductModeSaving) return;
    const mode = e.detail && e.detail.value;
    if (mode !== 'auto' && mode !== 'per_order') return;
    if (mode === this.data.deductMode) return;
    const prev = this.data.deductMode;
    const labelFor = (m) => (m === 'per_order' ? '逐单微信支付' : '自动扣余额');
    this.setData({
      deductMode: mode,
      modeLabel: labelFor(mode),
      deductModeSaving: true,
    });
    try {
      wx.showLoading({ title: '保存中' });
      await putMerchantCommissionDeductMode(mode);
      wx.hideLoading();
      wx.showToast({ title: '已切换扣款方式', icon: 'success' });
      await this.loadWallet();
    } catch (err) {
      wx.hideLoading();
      this.setData({
        deductMode: prev,
        modeLabel: labelFor(prev),
      });
      if (!isMerchant401(err)) ui.showError(err.message || '保存失败');
    } finally {
      this.setData({ deductModeSaving: false });
    }
  },

  async wxLoginCode() {
    return new Promise((resolve, reject) => {
      wx.login({
        success: (r) => (r.code ? resolve(r.code) : reject(new Error('无 code'))),
        fail: reject,
      });
    });
  },

  async runJsapiPay(prepayPayload) {
    const { timeStamp, nonceStr, package: pkg, signType, paySign } = prepayPayload;
    await new Promise((resolve, reject) => {
      wx.requestPayment({
        timeStamp,
        nonceStr,
        package: pkg,
        signType: signType || 'RSA',
        paySign,
        success: resolve,
        fail: reject,
      });
    });
  },

  async onRecharge() {
    try {
      const amt = parseFloat(this.data.rechargeAmount);
      if (!(amt >= 1)) {
        ui.showError('请输入不少于 1 元的金额');
        return;
      }
      wx.showLoading({ title: '下单中' });
      const code = await this.wxLoginCode();
      const prepay = await merchantCommissionRechargePrepay(amt, code);
      wx.hideLoading();
      await this.runJsapiPay(prepay);
      wx.showToast({ title: '支付成功', icon: 'success' });
      await this.refreshAll();
    } catch (err) {
      wx.hideLoading();
      if (err.errMsg && String(err.errMsg).indexOf('cancel') >= 0) return;
      if (isMerchant401(err)) return;
      ui.showError(err.message || err.errMsg || '支付失败');
    }
  },

  async onPayOrder(e) {
    const orderId = e.currentTarget.dataset.id;
    if (!orderId) return;
    try {
      wx.showLoading({ title: '下单中' });
      const code = await this.wxLoginCode();
      const prepay = await merchantCommissionPayOrderPrepay(orderId, code);
      wx.hideLoading();
      await this.runJsapiPay(prepay);
      wx.showToast({ title: '支付成功', icon: 'success' });
      await this.refreshAll();
    } catch (err) {
      wx.hideLoading();
      if (err.errMsg && String(err.errMsg).indexOf('cancel') >= 0) return;
      if (isMerchant401(err)) return;
      ui.showError(err.message || err.errMsg || '支付失败');
    }
  },

  async onRefund() {
    const amt = parseFloat(this.data.refundAmount);
    if (!(amt > 0)) {
      ui.showError('请输入退款金额');
      return;
    }
    try {
      wx.showLoading({ title: '处理中' });
      await merchantCommissionRefund(amt);
      wx.hideLoading();
      wx.showToast({ title: '已提交退款', icon: 'success' });
      await this.refreshAll();
    } catch (err) {
      wx.hideLoading();
      if (isMerchant401(err)) return;
      ui.showError(err.message || '失败');
    }
  },

  async onPickProof() {
    try {
      const r = await new Promise((resolve, reject) => {
        wx.chooseImage({
          count: 3,
          sizeType: ['compressed'],
          sourceType: ['album', 'camera'],
          success: resolve,
          fail: reject,
        });
      });
      const paths = r.tempFilePaths || [];
      wx.showLoading({ title: '上传中' });
      const urls = [];
      for (const p of paths) {
        urls.push(await merchantUploadImage(p));
      }
      wx.hideLoading();
      this.setData({ proofUrls: (this.data.proofUrls || []).concat(urls) });
    } catch (err) {
      wx.hideLoading();
      if (isMerchant401(err)) return;
      ui.showError(err.message || '上传失败');
    }
  },

  async onFinalize() {
    const orderId = (this.data.finalizeOrderId || '').trim();
    const actual = parseFloat(this.data.finalizeAmount);
    if (!orderId) {
      ui.showError('请填写订单号');
      return;
    }
    if (Number.isNaN(actual) || actual <= 0) {
      ui.showError('请填写实际维修金额');
      return;
    }
    try {
      wx.showLoading({ title: '提交中' });
      await merchantCommissionFinalize(orderId, {
        actual_amount: actual,
        payment_proof_urls: this.data.proofUrls || [],
      });
      wx.hideLoading();
      wx.showToast({ title: '已提交', icon: 'success' });
      this.setData({ finalizeOrderId: '', finalizeAmount: '', proofUrls: [] });
      await this.refreshAll();
    } catch (err) {
      wx.hideLoading();
      if (isMerchant401(err)) return;
      ui.showError(err.message || '失败');
    }
  },
});
