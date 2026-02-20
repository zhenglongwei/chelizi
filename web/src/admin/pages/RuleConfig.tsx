import { useState, useEffect } from 'react';
import { Card, Form, InputNumber, Button, message, Typography, Space, Alert } from 'antd';
import { Link } from 'react-router-dom';
import { callCloudFunction } from '../utils/api';
import { parseSystemConfig, flattenSystemConfig, getDefaultSystemConfig } from '../utils/systemConfig';

const { Title } = Typography;

export default function RuleConfig() {
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
        
        const weights = config.recommendationWeights || {};
        form.setFieldsValue({
          priceWeight: weights.price || 40,
          violationWeight: weights.violations || 25,
          accuracyWeight: weights.accuracy || 10,
          satisfactionWeight: weights.satisfaction || 20,
          distanceWeight: weights.distance || 5,
          warningThreshold: config.quoteWarningThreshold || 30,
          priceBottomLine: config.priceBottomLine || 90,
          deviationThreshold: config.quoteDeviationThreshold || 20,
        });
      }
    } catch (error) {
      console.error('加载配置失败:', error);
    }
  };

  const handleSubmit = async (values: any) => {
    setLoading(true);
    try {
      // 验证必填字段
      if (values.priceWeight === undefined || values.priceWeight === null ||
          values.violationWeight === undefined || values.violationWeight === null ||
          values.accuracyWeight === undefined || values.accuracyWeight === null ||
          values.satisfactionWeight === undefined || values.satisfactionWeight === null ||
          values.distanceWeight === undefined || values.distanceWeight === null) {
        message.error('请填写所有必填字段');
        setLoading(false);
        return;
      }

      // 构建配置对象（奖励金规则、佣金配置已迁移至「奖励金规则配置」页面）
      const config: any = {
        recommendationWeights: {
          price: Number(values.priceWeight),
          violations: Number(values.violationWeight),
          accuracy: Number(values.accuracyWeight),
          satisfaction: Number(values.satisfactionWeight),
          distance: Number(values.distanceWeight),
        },
        quoteWarningThreshold: Number(values.warningThreshold),
        priceBottomLine: Number(values.priceBottomLine),
        quoteDeviationThreshold: Number(values.deviationThreshold),
      };

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
        message.success('规则配置保存成功');
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

  return (
    <div className="rule-config" style={{ padding: '0 24px' }}>
      <Title level={2}>推荐规则配置</Title>
      <Alert
        type="info"
        showIcon
        message="奖励金规则、订单分级、佣金配置已迁移至「奖励金规则配置」页面"
        description={<Link to="/admin/reward-rules">前往奖励金规则配置 →</Link>}
        style={{ marginBottom: 24 }}
      />
      <Card>
        <Form
          form={form}
          onFinish={handleSubmit}
          layout="vertical"
        >
          <Title level={4}>权重配置</Title>
          <Form.Item
            name="priceWeight"
            label="价格权重（分）"
            rules={[{ required: true, message: '请输入价格权重' }]}
          >
            <InputNumber min={0} max={100} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="violationWeight"
            label="违规记录权重（分）"
            rules={[{ required: true, message: '请输入违规记录权重' }]}
          >
            <InputNumber min={0} max={100} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="accuracyWeight"
            label="报价准确性权重（分）"
            rules={[{ required: true, message: '请输入报价准确性权重' }]}
          >
            <InputNumber min={0} max={100} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="satisfactionWeight"
            label="车主满意度权重（分）"
            rules={[{ required: true, message: '请输入车主满意度权重' }]}
          >
            <InputNumber min={0} max={100} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="distanceWeight"
            label="距离权重（分）"
            rules={[{ required: true, message: '请输入距离权重' }]}
          >
            <InputNumber min={0} max={100} style={{ width: '100%' }} />
          </Form.Item>

          <Title level={4} style={{ marginTop: 32 }}>预警阈值设置</Title>
          <Form.Item
            name="warningThreshold"
            label="报价预警阈值（%）"
            rules={[{ required: true, message: '请输入报价预警阈值' }]}
          >
            <InputNumber min={0} max={100} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="priceBottomLine"
            label="价格底线（%）"
            rules={[{ required: true, message: '请输入价格底线' }]}
          >
            <InputNumber min={0} max={100} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="deviationThreshold"
            label="报价偏离度惩罚阈值（%）"
            rules={[{ required: true, message: '请输入报价偏离度惩罚阈值' }]}
          >
            <InputNumber min={0} max={100} style={{ width: '100%' }} />
          </Form.Item>

          <Form.Item>
            <Space>
              <Button type="primary" htmlType="submit" loading={loading}>
                保存配置
              </Button>
              <Button onClick={() => form.resetFields()}>重置</Button>
            </Space>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
}

