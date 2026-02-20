import { useState, useEffect } from 'react';
import {
  Card,
  Table,
  Button,
  Modal,
  Tag,
  message,
  Typography,
  Space,
} from 'antd';
import { CheckOutlined, CloseOutlined } from '@ant-design/icons';
import api from '../utils/api';
import dayjs from 'dayjs';

const { Title } = Typography;

export default function ComplexityUpgrade() {
  const [list, setList] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [auditingId, setAuditingId] = useState<string | null>(null);

  useEffect(() => {
    loadList();
  }, [page, pageSize, statusFilter]);

  const loadList = async () => {
    setLoading(true);
    try {
      const params: any = { page, pageSize };
      if (statusFilter !== '') params.status = statusFilter;
      const res = await api.get('/v1/admin/complexity-upgrade/list', { params });
      const data = res?.data ?? res;
      setList(data.list || []);
      setTotal(data.total || 0);
    } catch (error: any) {
      message.error(error.message || '加载失败');
      setList([]);
    } finally {
      setLoading(false);
    }
  };

  const handleAudit = async (requestId: string, status: 1 | 2) => {
    setAuditingId(requestId);
    try {
      await api.post(`/v1/admin/complexity-upgrade/${requestId}/audit`, { status });
      message.success(status === 1 ? '已通过' : '已拒绝');
      loadList();
    } catch (error: any) {
      message.error(error.message || '操作失败');
    } finally {
      setAuditingId(null);
    }
  };

  const statusMap: Record<number, { color: string; text: string }> = {
    0: { color: 'orange', text: '待审核' },
    1: { color: 'green', text: '已通过' },
    2: { color: 'red', text: '已拒绝' },
  };

  const columns = [
    { title: '申请ID', dataIndex: 'requestId', key: 'requestId', width: 140, ellipsis: true },
    { title: '订单ID', dataIndex: 'orderId', key: 'orderId', width: 140, ellipsis: true },
    { title: '用户', dataIndex: 'userName', key: 'userName', width: 100 },
    { title: '当前等级', dataIndex: 'currentLevel', key: 'currentLevel', width: 90 },
    { title: '申请等级', dataIndex: 'requestedLevel', key: 'requestedLevel', width: 90 },
    { title: '申请理由', dataIndex: 'reason', key: 'reason', ellipsis: true },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (s: number) => {
        const config = statusMap[s] || { color: 'default', text: String(s) };
        return <Tag color={config.color}>{config.text}</Tag>;
      },
    },
    {
      title: '申请时间',
      dataIndex: 'createTime',
      key: 'createTime',
      width: 170,
      render: (t: string) => (t ? dayjs(t).format('YYYY-MM-DD HH:mm') : '-'),
    },
    {
      title: '操作',
      key: 'action',
      width: 160,
      render: (_: any, record: any) =>
        record.status === 0 ? (
          <Space>
            <Button
              type="link"
              size="small"
              icon={<CheckOutlined />}
              onClick={() => handleAudit(record.requestId, 1)}
              loading={auditingId === record.requestId}
            >
              通过
            </Button>
            <Button
              type="link"
              size="small"
              danger
              icon={<CloseOutlined />}
              onClick={() => handleAudit(record.requestId, 2)}
              loading={auditingId === record.requestId}
            >
              拒绝
            </Button>
          </Space>
        ) : (
          '-'
        ),
    },
  ];

  return (
    <div className="complexity-upgrade">
      <Title level={2}>破格升级审核</Title>
      <Card>
        <p style={{ marginBottom: 16, color: '#666' }}>
          用户针对系统未覆盖的特殊高复杂度场景（如老车小众故障、维修维权返工）可申请复杂度等级升级，由持证技师人工复核，24 小时内完成。
        </p>
        <Space style={{ marginBottom: 16 }}>
          <Button onClick={() => setStatusFilter('')}>全部</Button>
          <Button onClick={() => setStatusFilter('0')}>待审核</Button>
          <Button onClick={() => setStatusFilter('1')}>已通过</Button>
          <Button onClick={() => setStatusFilter('2')}>已拒绝</Button>
        </Space>
        <Table
          columns={columns}
          dataSource={list}
          loading={loading}
          rowKey="requestId"
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (t) => `共 ${t} 条`,
            onChange: (p, s) => {
              setPage(p);
              setPageSize(s || 20);
            },
          }}
        />
      </Card>
    </div>
  );
}
