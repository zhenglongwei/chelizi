/**
 * 标品货款对公提现：待财务打款列表、核销 / 驳回
 */
import { useState, useEffect } from 'react';
import { Card, Table, Button, Space, Tag, Modal, Input, message, Select } from 'antd';
import api from '../utils/api';

const STATUS_MAP: Record<number, { label: string; color: string }> = {
  0: { label: '待财务', color: 'orange' },
  1: { label: '已完成', color: 'green' },
  2: { label: '已驳回', color: 'red' },
  3: { label: '已撤销', color: 'default' },
};

type Row = {
  request_id: string;
  shop_id: string;
  shop_name: string;
  amount: number;
  company_name: string;
  bank_name: string;
  bank_account_no: string;
  bank_account_masked?: string;
  bank_branch: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  merchant_remark: string | null;
  status: number;
  admin_remark: string | null;
  finance_ref: string | null;
  created_at: string;
  processed_at: string | null;
};

export default function CorpIncomeWithdraw() {
  const [list, setList] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(20);
  const [statusFilter, setStatusFilter] = useState<string>('0');
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<Row | null>(null);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [financeRef, setFinanceRef] = useState('');
  const [adminRemark, setAdminRemark] = useState('');
  const [rejectReason, setRejectReason] = useState('');

  const loadList = async (p = page, st = statusFilter) => {
    setLoading(true);
    try {
      const res: any = await api.get('/v1/admin/shop-income/corp-withdrawals', {
        params: { page: p, limit, status: st === 'all' ? undefined : st },
      });
      const data = res?.data ?? res;
      setList(data?.list ?? []);
      setTotal(data?.total ?? 0);
      setPage(data?.page ?? p);
    } catch (e: any) {
      message.error(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadList(1, statusFilter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  const openComplete = (row: Row) => {
    setDetail(row);
    setFinanceRef('');
    setAdminRemark('');
    setCompleteOpen(true);
  };

  const openReject = (row: Row) => {
    setDetail(row);
    setRejectReason('');
    setRejectOpen(true);
  };

  const handleComplete = async () => {
    if (!detail) return;
    try {
      await api.post(`/v1/admin/shop-income/corp-withdrawals/${detail.request_id}/complete`, {
        finance_ref: financeRef || undefined,
        admin_remark: adminRemark || undefined,
      });
      message.success('已核销');
      setCompleteOpen(false);
      setDetail(null);
      loadList(page, statusFilter);
    } catch (e: any) {
      message.error(e?.message || '失败');
    }
  };

  const handleReject = async () => {
    if (!detail) return;
    try {
      await api.post(`/v1/admin/shop-income/corp-withdrawals/${detail.request_id}/reject`, {
        reason: rejectReason || '不符合打款要求',
      });
      message.success('已驳回');
      setRejectOpen(false);
      setDetail(null);
      loadList(page, statusFilter);
    } catch (e: any) {
      message.error(e?.message || '失败');
    }
  };

  const columns = [
    { title: '申请单号', dataIndex: 'request_id', key: 'request_id', width: 140, ellipsis: true },
    { title: '店铺', dataIndex: 'shop_name', key: 'shop_name', width: 120, ellipsis: true },
    {
      title: '金额',
      dataIndex: 'amount',
      key: 'amount',
      width: 88,
      render: (v: number) => `¥${v}`,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 88,
      render: (s: number) => {
        const m = STATUS_MAP[s] || { label: String(s), color: 'default' };
        return <Tag color={m.color}>{m.label}</Tag>;
      },
    },
    { title: '户名', dataIndex: 'company_name', key: 'company_name', width: 120, ellipsis: true },
    { title: '银行', dataIndex: 'bank_name', key: 'bank_name', width: 100, ellipsis: true },
    {
      title: '账号',
      key: 'acct',
      width: 120,
      render: (_: unknown, row: Row) => row.bank_account_masked || `****${String(row.bank_account_no || '').slice(-4)}`,
    },
    { title: '申请时间', dataIndex: 'created_at', key: 'created_at', width: 168 },
    {
      title: '操作',
      key: 'action',
      width: 180,
      fixed: 'right' as const,
      render: (_: unknown, row: Row) =>
        row.status === 0 ? (
          <Space>
            <Button type="primary" size="small" onClick={() => openComplete(row)}>
              核销
            </Button>
            <Button size="small" danger onClick={() => openReject(row)}>
              驳回
            </Button>
          </Space>
        ) : null,
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Card
        title="标品货款 · 对公提现"
        extra={
          <Space>
            <span>状态</span>
            <Select
              style={{ width: 120 }}
              value={statusFilter}
              onChange={(v) => {
                setStatusFilter(v);
                setPage(1);
              }}
              options={[
                { value: '0', label: '待财务' },
                { value: 'all', label: '全部' },
                { value: '1', label: '已完成' },
                { value: '2', label: '已驳回' },
                { value: '3', label: '已撤销' },
              ]}
            />
            <Button onClick={() => loadList(page, statusFilter)}>刷新</Button>
          </Space>
        }
      >
        <Table<Row>
          rowKey="request_id"
          loading={loading}
          dataSource={list}
          columns={columns}
          scroll={{ x: 1100 }}
          pagination={{
            current: page,
            pageSize: limit,
            total,
            showTotal: (t) => `共 ${t} 条`,
            onChange: (p) => loadList(p, statusFilter),
          }}
        />
      </Card>

      <Modal
        title="核销（确认已线下打款）"
        open={completeOpen}
        onOk={handleComplete}
        onCancel={() => setCompleteOpen(false)}
        okText="确认核销"
      >
        {detail ? (
          <div style={{ marginBottom: 12 }}>
            <p>
              <strong>{detail.company_name}</strong> · ¥{detail.amount}
            </p>
            <p className="text-muted" style={{ fontSize: 12 }}>
              {detail.bank_name} {detail.bank_account_no}
            </p>
            {detail.bank_branch ? <p style={{ fontSize: 12 }}>支行：{detail.bank_branch}</p> : null}
          </div>
        ) : null}
        <Input
          placeholder="财务凭证/流水号（选填）"
          value={financeRef}
          onChange={(e) => setFinanceRef(e.target.value)}
          style={{ marginBottom: 8 }}
        />
        <Input.TextArea
          placeholder="备注（选填）"
          value={adminRemark}
          onChange={(e) => setAdminRemark(e.target.value)}
          rows={2}
        />
      </Modal>

      <Modal title="驳回" open={rejectOpen} onOk={handleReject} onCancel={() => setRejectOpen(false)} okText="确认驳回">
        <Input.TextArea
          placeholder="驳回原因（将展示给商户）"
          value={rejectReason}
          onChange={(e) => setRejectReason(e.target.value)}
          rows={3}
        />
      </Modal>
    </div>
  );
}
