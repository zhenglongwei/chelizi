import { useState, useEffect } from 'react';
import {
  Table,
  Card,
  Tabs,
  Typography,
  Space,
  Button,
  message,
  DatePicker,
} from 'antd';
import { DollarOutlined, WalletOutlined, FileTextOutlined } from '@ant-design/icons';
import { callCloudFunction } from '../utils/api';
import dayjs from 'dayjs';

const { Title, Text } = Typography;
const { RangePicker } = DatePicker;

export default function SettlementManagement() {
  const [loading, setLoading] = useState(false);
  const [settlements, setSettlements] = useState<any[]>([]);
  const [refunds, setRefunds] = useState<any[]>([]);
  const [deposits, setDeposits] = useState<any[]>([]);
  const [commissionLedger, setCommissionLedger] = useState<any[]>([]);
  const [dateRange, setDateRange] = useState<[dayjs.Dayjs, dayjs.Dayjs]>([
    dayjs().subtract(89, 'day'),
    dayjs(),
  ]);

  const loadData = async () => {
    setLoading(true);
    try {
      const start = dateRange[0].format('YYYY-MM-DD');
      const end = dateRange[1].format('YYYY-MM-DD');
      const result = await callCloudFunction('getSettlements', { start, end });
      if (result.success) {
        setSettlements(result.data.settlements || []);
        setRefunds(result.data.refunds || []);
        setDeposits(result.data.deposits || []);
        setCommissionLedger(result.data.commissionLedger || []);
      } else {
        message.error(result.message || '加载数据失败');
      }
    } catch (error: any) {
      console.error('加载数据失败:', error);
      message.error('加载数据失败: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const orderKindLabel = (k: string) =>
    k === 'product' ? '标品订单' : k === 'repair' ? '维修单' : k === 'unknown' ? '未识别' : k || '-';

  const commissionColumns = [
    {
      title: '订单类型',
      dataIndex: 'orderKind',
      key: 'orderKind',
      width: 100,
      render: (k: string) => orderKindLabel(k),
    },
    { title: '订单号', dataIndex: 'orderNo', key: 'orderNo' },
    { title: '服务商', dataIndex: 'merchantName', key: 'merchantName' },
    {
      title: '订单金额',
      dataIndex: 'orderAmount',
      key: 'orderAmount',
      render: (val: number) => `¥${Number(val ?? 0).toFixed(2)}`,
    },
    {
      title: '佣金金额',
      dataIndex: 'commission',
      key: 'commission',
      render: (val: number) => `¥${Number(val ?? 0).toFixed(2)}`,
    },
    { title: '佣金收款状态', dataIndex: 'commissionStatus', key: 'commissionStatus' },
    { 
      title: '结算时间', 
      dataIndex: 'settlementTime', 
      key: 'settlementTime',
      render: (time: Date) => time ? dayjs(time).format('YYYY-MM-DD HH:mm:ss') : '-'
    },
  ];

  const refundColumns = [
    {
      title: '订单类型',
      dataIndex: 'orderKind',
      key: 'orderKind',
      width: 100,
      render: (k: string) => orderKindLabel(k),
    },
    { title: '订单号', dataIndex: 'orderNo', key: 'orderNo' },
    { title: '评价ID', dataIndex: 'reviewId', key: 'reviewId', ellipsis: true },
    { title: '车主', dataIndex: 'ownerName', key: 'ownerName' },
    {
      title: '奖励金金额',
      dataIndex: 'refundAmount',
      key: 'refundAmount',
      render: (val: number) => `¥${Number(val ?? 0).toFixed(2)}`,
    },
    {
      title: '订单分级',
      dataIndex: 'reward_tier',
      key: 'reward_tier',
      render: (tier: number) => (tier != null ? ['一级', '二级', '三级', '四级'][tier - 1] : '-'),
    },
    {
      title: '评价阶段',
      dataIndex: 'review_stage',
      key: 'review_stage',
      render: (stage: string) => {
        const stageMap: any = { main: '主评价', '1m': '1个月追评', '3m': '3个月追评' };
        return stageMap[stage] || stage || '-';
      }
    },
    {
      title: '代扣个税',
      dataIndex: 'tax_deducted',
      key: 'tax_deducted',
      render: (v: number) => (v != null && v > 0 ? `¥${v}` : '-'),
    },
    {
      title: '到账时间',
      dataIndex: 'arrivalTime',
      key: 'arrivalTime',
      render: (time: Date) => time ? dayjs(time).format('YYYY-MM-DD HH:mm:ss') : '-'
    },
    {
      title: '类型',
      dataIndex: 'refundType',
      key: 'refundType',
      render: (type: string) => {
        const typeMap: any = {
          'order': '订单奖励金',
          'referral': '裂变奖励金'
        };
        return typeMap[type] || type || '-';
      }
    },
  ];

  const depositColumns = [
    { title: '店铺', dataIndex: 'merchantName', key: 'merchantName' },
    { title: 'shop_id', dataIndex: 'shopId', key: 'shopId', ellipsis: true },
    { title: '佣金钱包(元)', dataIndex: 'balance', key: 'balance', render: (val: number) => `¥${val ?? 0}` },
    { title: '冻结(元)', dataIndex: 'frozen', key: 'frozen', render: (val: number) => `¥${val || 0}` },
    { title: '扣款模式', dataIndex: 'deductMode', key: 'deductMode' },
    {
      title: '最后变动时间',
      dataIndex: 'updateTime',
      key: 'updateTime',
      render: (time: Date) => (time ? dayjs(time).format('YYYY-MM-DD HH:mm:ss') : '-'),
    },
  ];

  const ledgerColumns = [
    { title: '流水号', dataIndex: 'ledgerId', key: 'ledgerId', ellipsis: true },
    { title: '店铺', dataIndex: 'merchantName', key: 'merchantName' },
    { title: 'shop_id', dataIndex: 'shopId', key: 'shopId', ellipsis: true },
    { title: '类型', dataIndex: 'type', key: 'type' },
    { title: '金额', dataIndex: 'amount', key: 'amount', render: (v: number) => `¥${v}` },
    { title: '订单', dataIndex: 'orderId', key: 'orderId', ellipsis: true },
    { title: '备注', dataIndex: 'remark', key: 'remark', ellipsis: true },
    {
      title: '时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (t: Date) => (t ? dayjs(t).format('YYYY-MM-DD HH:mm:ss') : '-'),
    },
  ];

  const exportLedgerCsv = () => {
    const rows = commissionLedger;
    const header = ['ledgerId', 'shopId', 'merchantName', 'type', 'amount', 'orderId', 'remark', 'createdAt'];
    const lines = [header.join(',')].concat(
      rows.map((r) =>
        header
          .map((k) => {
            const v = r[k];
            if (v == null) return '';
            const s = String(v).replace(/"/g, '""');
            return `"${s}"`;
          })
          .join(',')
      )
    );
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `commission-ledger-${dayjs().format('YYYYMMDD-HHmm')}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const tabItems = [
    {
      key: 'commission',
      label: (
        <span>
          <DollarOutlined />
          佣金结算
        </span>
      ),
      children: (
        <Table
          columns={commissionColumns}
          dataSource={settlements}
          loading={loading}
          rowKey={(r) => `${r.orderKind || 'x'}-${r.orderNo}`}
          pagination={{ pageSize: 15, showSizeChanger: true }}
        />
      ),
    },
    {
      key: 'refund',
      label: (
        <span>
          <WalletOutlined />
          奖励金管理
        </span>
      ),
      children: (
        <Table
          columns={refundColumns}
          dataSource={refunds}
          loading={loading}
          rowKey={(r) => r.reviewId || r.transaction_id || `${r.orderNo}-${r.review_stage}`}
          pagination={{ pageSize: 15, showSizeChanger: true }}
        />
      ),
    },
    {
      key: 'deposit',
      label: (
        <span>
          <FileTextOutlined />
          佣金钱包
        </span>
      ),
      children: (
        <Table
          columns={depositColumns}
          dataSource={deposits}
          loading={loading}
          rowKey={(r) => r.shopId || String(Math.random())}
          pagination={{ pageSize: 10 }}
        />
      ),
    },
    {
      key: 'commission_ledger',
      label: (
        <span>
          <FileTextOutlined />
          佣金流水
        </span>
      ),
      children: (
        <>
          <Space style={{ marginBottom: 12 }}>
            <Button type="primary" onClick={exportLedgerCsv} disabled={!commissionLedger.length}>
              导出 CSV
            </Button>
          </Space>
          <Table
            columns={ledgerColumns}
            dataSource={commissionLedger}
            loading={loading}
            rowKey={(r) => r.ledgerId || String(Math.random())}
            pagination={{ pageSize: 15 }}
          />
        </>
      ),
    },
  ];

  return (
    <div className="settlement-management" style={{ padding: '0 24px' }}>
      <Title level={2}>结算管理</Title>
      <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
        佣金结算含<strong>维修完工单</strong>与<strong>已支付标品订单</strong>（平台抽成可为 0）；奖励金管理按评价维度列出，含应发为 0 或未产生流水账的记录。切换 Tab 前请先点「查询」刷新。
      </Text>

      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Text>全局时间范围：</Text>
          <RangePicker value={dateRange} onChange={(v) => v && v[0] && v[1] && setDateRange([v[0], v[1]])} />
          <Button type="primary" onClick={loadData} loading={loading}>
            查询
          </Button>
        </Space>
        <Tabs items={tabItems} />
      </Card>
    </div>
  );
}

