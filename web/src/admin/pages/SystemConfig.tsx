import { useState, useEffect } from 'react';
import { Card, Form, Input, InputNumber, Button, message, Typography, Tabs, Switch } from 'antd';
import { callCloudFunction } from '../utils/api';
import { parseSystemConfig, flattenSystemConfig, getDefaultSystemConfig } from '../utils/systemConfig';

const { Title } = Typography;

export default function SystemConfig() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadConfig();
    loadBiddingDistConfig();
  }, []);

  const loadConfig = async () => {
    try {
      // 使用 queryData 查询系统配置
      const result = await callCloudFunction('queryData', {
        collection: 'system_config'
      });
      
      if (result.success) {
        // 前端处理扁平化逻辑
        const configList = result.data || [];
        const defaultConfig = getDefaultSystemConfig();
        const config = parseSystemConfig(configList, defaultConfig);
        
        form.setFieldsValue({
          platformName: config.platformName || '事故车维修竞价平台',
          commissionRate: config.commissionRate?.oem || 2,
          refundRate: config.refundRate || 10,
          quoteTimeout: config.quoteTimeoutHours || 2,
          requireSettlementBeforeReview: config.require_settlement_before_review === '1',
          nearbyMaxKm: config.nearby_max_km != null ? Number(config.nearby_max_km) : 50,
        });
      }
    } catch (error) {
      console.error('加载配置失败:', error);
    }
  };

  const handleSubmit = async (values: any) => {
    setLoading(true);
    try {
      // 构建配置对象
      const config: any = {};
      
      if (values.platformName !== undefined && values.platformName !== null && values.platformName !== '') {
        config.platformName = String(values.platformName);
      }
      
      if (values.commissionRate !== undefined && values.commissionRate !== null) {
        config.commissionRate = {
          oem: Number(values.commissionRate),
          nonOem: Number(values.commissionRate) + 10 // 非原厂件包含返现
        };
      }
      
      if (values.refundRate !== undefined && values.refundRate !== null) {
        config.refundRate = Number(values.refundRate);
      }
      
      if (values.quoteTimeout !== undefined && values.quoteTimeout !== null) {
        config.quoteTimeout = {
          small: Number(values.quoteTimeout),
          large: Number(values.quoteTimeout) * 2 // 大额事故是2倍时间
        };
      }

      if (values.requireSettlementBeforeReview !== undefined && values.requireSettlementBeforeReview !== null) {
        config.require_settlement_before_review = values.requireSettlementBeforeReview ? '1' : '0';
      }

      if (values.nearbyMaxKm !== undefined && values.nearbyMaxKm !== null) {
        config.nearby_max_km = Number(values.nearbyMaxKm);
      }

      // 检查是否有有效配置
      if (Object.keys(config).length === 0) {
        message.error('请至少填写一个配置项');
        setLoading(false);
        return;
      }

      console.log('准备保存配置:', config);
      
      // 前端扁平化处理
      const flatConfig = flattenSystemConfig(config);
      
      // 批量更新配置（每个配置项单独调用）
      const promises = Object.keys(flatConfig).map(async (key) => {
        const value = flatConfig[key];
        
        // 检查是否存在
        const existResult = await callCloudFunction('queryData', {
          collection: 'system_config',
          where: { key },
          limit: 1
        });
        
        if (existResult.success && existResult.data?.length > 0) {
          // 更新
          return callCloudFunction('updateData', {
            collection: 'system_config',
            where: { key },
            data: { value }
          });
        } else {
          // 新增
          return callCloudFunction('addData', {
            collection: 'system_config',
            data: { key, value }
          });
        }
      });
      
      const results = await Promise.all(promises);
      const hasError = results.some(r => !r.success);
      
      if (!hasError) {
        message.success('配置保存成功');
      } else {
        message.error('部分配置保存失败');
      }
    } catch (error: any) {
      console.error('保存失败:', error);
      message.error(error.message || '保存失败');
    } finally {
      setLoading(false);
    }
  };

  const [biddingDistForm] = Form.useForm();
  const [biddingDistLoading, setBiddingDistLoading] = useState(false);

  const loadBiddingDistConfig = async () => {
    try {
      const result = await callCloudFunction('queryData', { collection: 'system_config' });
      const configList = result.data || [];
      const item = configList.find((c: any) => c.key === 'biddingDistribution');
      let cfg: any = {};
      if (item?.value) {
        try {
          cfg = JSON.parse(item.value);
        } catch (_) {}
      }
      biddingDistForm.setFieldsValue({
        filterComplianceMin: cfg.filterComplianceMin ?? 80,
        filterViolationDays: cfg.filterViolationDays ?? 30,
        fallbackDistanceExpandRate: cfg.fallbackDistanceExpandRate ?? 0.2,
        fallbackMinShops: cfg.fallbackMinShops ?? 3,
        tier1MatchScoreMin: cfg.tier1MatchScoreMin ?? 80,
        tier1ComplianceMin: cfg.tier1ComplianceMin ?? 95,
        tier2MatchScoreMin: cfg.tier2MatchScoreMin ?? 60,
        tier2MatchScoreMax: cfg.tier2MatchScoreMax ?? 79,
        tier2ComplianceMin: cfg.tier2ComplianceMin ?? 85,
        tier1ExclusiveMinutes: cfg.tier1ExclusiveMinutes ?? 15,
        tier3MaxShops: cfg.tier3MaxShops ?? 2,
        distributeL1L2Max: cfg.distributeL1L2Max ?? 10,
        distributeL1L2ValidStop: cfg.distributeL1L2ValidStop ?? 5,
        distributeL3L4Max: cfg.distributeL3L4Max ?? 15,
        distributeL3L4ValidStop: cfg.distributeL3L4ValidStop ?? 8,
        newShopDays: cfg.newShopDays ?? 90,
        newShopBaseScore: cfg.newShopBaseScore ?? 60,
        sameProjectScorePriority: cfg.sameProjectScorePriority ?? 15,
        sameProjectScoreFallback: cfg.sameProjectScoreFallback ?? 5,
      });
    } catch (_) {}
  };

  const handleBiddingDistSubmit = async (values: any) => {
    setBiddingDistLoading(true);
    try {
      const cfg = {
        filterComplianceMin: Number(values.filterComplianceMin) ?? 80,
        filterViolationDays: Number(values.filterViolationDays) ?? 30,
        fallbackDistanceExpandRate: Number(values.fallbackDistanceExpandRate) ?? 0.2,
        fallbackMinShops: Number(values.fallbackMinShops) ?? 3,
        tier1MatchScoreMin: Number(values.tier1MatchScoreMin) ?? 80,
        tier1ComplianceMin: Number(values.tier1ComplianceMin) ?? 95,
        tier2MatchScoreMin: Number(values.tier2MatchScoreMin) ?? 60,
        tier2MatchScoreMax: Number(values.tier2MatchScoreMax) ?? 79,
        tier2ComplianceMin: Number(values.tier2ComplianceMin) ?? 85,
        tier1ExclusiveMinutes: Number(values.tier1ExclusiveMinutes) ?? 15,
        tier3MaxShops: Number(values.tier3MaxShops) ?? 2,
        distributeL1L2Max: Number(values.distributeL1L2Max) ?? 10,
        distributeL1L2ValidStop: Number(values.distributeL1L2ValidStop) ?? 5,
        distributeL3L4Max: Number(values.distributeL3L4Max) ?? 15,
        distributeL3L4ValidStop: Number(values.distributeL3L4ValidStop) ?? 8,
        newShopDays: Number(values.newShopDays) ?? 90,
        newShopBaseScore: Number(values.newShopBaseScore) ?? 60,
        sameProjectScorePriority: Number(values.sameProjectScorePriority) ?? 15,
        sameProjectScoreFallback: Number(values.sameProjectScoreFallback) ?? 5,
      };
      await callCloudFunction('addData', {
        collection: 'system_config',
        data: { key: 'biddingDistribution', value: JSON.stringify(cfg) }
      });
      message.success('竞价分发配置已保存');
    } catch (e: any) {
      message.error(e.message || '保存失败');
    } finally {
      setBiddingDistLoading(false);
    }
  };

  const basicConfigItems = [
    {
      key: 'basic',
      label: '基础配置',
      children: (
        <Form form={form} onFinish={handleSubmit} layout="vertical">
          <Form.Item name="platformName" label="平台名称">
            <Input placeholder="请输入平台名称" />
          </Form.Item>
          <Form.Item name="commissionRate" label="佣金比例（%）">
            <InputNumber min={0} max={100} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="refundRate" label="返点比例（%）">
            <InputNumber min={0} max={100} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="quoteTimeout" label="报价时效（小时）">
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="requireSettlementBeforeReview"
            label="分账与评价开关"
            valuePropName="checked"
            tooltip="开启：需等分账完成才允许评价；关闭：确认完工即可评价（可提前返现）"
          >
            <Switch checkedChildren="需等分账" unCheckedChildren="可提前评价" />
          </Form.Item>
          <Form.Item
            name="nearbyMaxKm"
            label="附近维修厂最大距离（km）"
            tooltip="首页、搜索列表按此距离过滤，仅展示该范围内的维修厂"
          >
            <InputNumber min={1} max={500} style={{ width: '100%' }} placeholder="默认 50" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading}>
              保存配置
            </Button>
          </Form.Item>
        </Form>
      ),
    },
    {
      key: 'biddingDist',
      label: '竞价分发',
      children: (
        <Form form={biddingDistForm} onFinish={handleBiddingDistSubmit} layout="vertical">
          <Title level={5}>硬门槛</Title>
          <Form.Item name="filterComplianceMin" label="合规率最低要求（%）">
            <InputNumber min={0} max={100} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="filterViolationDays" label="重大违规统计天数">
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Title level={5}>兜底</Title>
          <Form.Item name="fallbackDistanceExpandRate" label="距离扩大幅度（0.2=20%）">
            <InputNumber min={0.1} max={1} step={0.1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="fallbackMinShops" label="兜底最少店铺数">
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Title level={5}>梯队</Title>
          <Form.Item name="tier1MatchScoreMin" label="第一梯队匹配分下限">
            <InputNumber min={0} max={100} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="tier1ComplianceMin" label="第一梯队合规率下限（%）">
            <InputNumber min={0} max={100} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="tier2MatchScoreMin" label="第二梯队匹配分下限">
            <InputNumber min={0} max={100} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="tier2MatchScoreMax" label="第二梯队匹配分上限">
            <InputNumber min={0} max={100} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="tier2ComplianceMin" label="第二梯队合规率下限（%）">
            <InputNumber min={0} max={100} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="tier1ExclusiveMinutes" label="第一梯队独家窗口（分钟）">
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="tier3MaxShops" label="第三梯队最多家数">
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Title level={5}>分发数量</Title>
          <Form.Item name="distributeL1L2Max" label="L1-L2 最多分发家数">
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="distributeL1L2ValidStop" label="L1-L2 有效报价满 N 家停止">
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="distributeL3L4Max" label="L3-L4 最多分发家数">
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="distributeL3L4ValidStop" label="L3-L4 有效报价满 N 家停止">
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Title level={5}>新店</Title>
          <Form.Item name="newShopDays" label="新店定义天数">
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="newShopBaseScore" label="新店基础分">
            <InputNumber min={0} max={100} style={{ width: '100%' }} />
          </Form.Item>
          <Title level={5}>同项目完单量分</Title>
          <Form.Item name="sameProjectScorePriority" label="优先匹配加分">
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="sameProjectScoreFallback" label="兜底匹配加分">
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={biddingDistLoading}>
              保存竞价分发配置
            </Button>
          </Form.Item>
        </Form>
      ),
    },
    {
      key: 'permission',
      label: '权限管理',
      children: <div>权限管理功能开发中</div>,
    },
  ];

  return (
    <div className="system-config">
      <Title level={2}>系统配置</Title>
      
      <Card>
        <Tabs items={basicConfigItems} />
      </Card>
    </div>
  );
}

