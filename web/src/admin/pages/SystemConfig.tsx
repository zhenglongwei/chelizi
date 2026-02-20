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

