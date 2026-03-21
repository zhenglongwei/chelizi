import { useState, useEffect } from 'react';
import {
  Table,
  Card,
  Tabs,
  Typography,
  Space,
  Button,
  message,
  Tag,
} from 'antd';
import { DollarOutlined, WalletOutlined, FileTextOutlined } from '@ant-design/icons';
import { callCloudFunction } from '../utils/api';
import dayjs from 'dayjs';

const { Title } = Typography;

export default function SettlementManagement() {
  const [loading, setLoading] = useState(false);
  const [settlements, setSettlements] = useState<any[]>([]);
  const [refunds, setRefunds] = useState<any[]>([]);
  const [deposits, setDeposits] = useState<any[]>([]);
  const [commissionLedger, setCommissionLedger] = useState<any[]>([]);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const result = await callCloudFunction('getSettlements', { type: 'all' });
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

  const commissionColumns = [
    { title: '订单号', dataIndex: 'orderNo', key: 'orderNo' },
    { title: '服务商', dataIndex: 'merchantName', key: 'merchantName' },
    { title: '订单金额', dataIndex: 'orderAmount', key: 'orderAmount', render: (val: number) => `¥${val}` },
    { title: '佣金金额', dataIndex: 'commission', key: 'commission', render: (val: number) => `¥${val}` },
    { title: '佣金收款状态', dataIndex: 'commissionStatus', key: 'commissionStatus' },
    { 
      title: '结算时间', 
      dataIndex: 'settlementTime', 
      key: 'settlementTime',
      render: (time: Date) => time ? dayjs(time).format('YYYY-MM-DD HH:mm:ss') : '-'
    },
  ];

  const refundColumns = [
    { title: '订单号', dataIndex: 'orderNo', key: 'orderNo' },
    { title: '车主', dataIndex: 'ownerName', key: 'ownerName' },
    { title: '奖励金金额', dataIndex: 'refundAmount', key: 'refundAmount', render: (val: number) => `¥${val}` },
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
          rowKey="orderNo"
          pagination={{ pageSize: 10 }}
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
          rowKey={(r) => r.transaction_id || r.orderNo || String(Math.random())}
          pagination={{ pageSize: 10 }}
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
    <div className="settlement-management">
      <Title level={2}>结算管理</Title>
      
      <Card>
        <Tabs items={tabItems} />
      </Card>
    </div>
  );
}

