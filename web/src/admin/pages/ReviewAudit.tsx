import { useState, useEffect } from 'react';
import {
  Card,
  Table,
  Button,
  Modal,
  Select,
  Input,
  Tag,
  message,
  Typography,
  Space,
} from 'antd';
import { CheckOutlined } from '@ant-design/icons';
import api from '../utils/api';
import dayjs from 'dayjs';

const { Title } = Typography;
const { TextArea } = Input;

export default function ReviewAudit() {
  const [list, setList] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [poolFilter, setPoolFilter] = useState<string>('');
  const [manualModalVisible, setManualModalVisible] = useState(false);
  const [selectedReview, setSelectedReview] = useState<any>(null);
  const [manualResult, setManualResult] = useState<'pass' | 'reject'>('pass');
  const [manualNote, setManualNote] = useState('');

  useEffect(() => {
    loadList();
  }, [page, pageSize, statusFilter, poolFilter]);

  const loadList = async () => {
    setLoading(true);
    try {
      const params: any = { page, pageSize };
      if (statusFilter) params.status = statusFilter;
      if (poolFilter) params.pool = poolFilter;
      const res = await api.get('/v1/admin/review-audit/list', { params });
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

  const handleManualReview = (review: any) => {
    setSelectedReview(review);
    setManualResult('pass');
    setManualNote('');
    setManualModalVisible(true);
  };

  const submitManualReview = async () => {
    if (!selectedReview) return;
    try {
      await api.post(`/v1/admin/review-audit/${selectedReview.reviewId}/manual`, {
        result: manualResult,
        missingItems: manualResult === 'reject' ? [manualNote] : undefined,
      });
      message.success('复核完成');
      setManualModalVisible(false);
      loadList();
    } catch (error: any) {
      message.error(error.message || '复核失败');
    }
  };

  const columns = [
    { title: '评价ID', dataIndex: 'reviewId', key: 'reviewId', width: 140, ellipsis: true },
    { title: '订单ID', dataIndex: 'orderId', key: 'orderId', width: 140, ellipsis: true },
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
      width: 80,
      render: (t: number) => (t === 1 ? '主评价' : t === 2 ? '追评' : '返厂'),
    },
    {
      title: '阶段',
      dataIndex: 'reviewStage',
      key: 'reviewStage',
      width: 90,
      render: (s: string) => (s === 'main' ? '主评价' : s === '1m' ? '1个月' : s === '3m' ? '3个月' : s || '-'),
    },
    {
      title: '审核结果',
      dataIndex: 'auditResult',
      key: 'auditResult',
      width: 90,
      render: (r: string) => (
        <Tag color={r === 'pass' ? 'green' : r === 'reject' ? 'red' : 'default'}>
          {r === 'pass' ? '通过' : r === 'reject' ? '不通过' : '-'}
        </Tag>
      ),
    },
    { title: '评分', dataIndex: 'rating', key: 'rating', width: 60 },
    { title: '内容', dataIndex: 'content', key: 'content', ellipsis: true },
    {
      title: '提交时间',
      dataIndex: 'createTime',
      key: 'createTime',
      width: 170,
      render: (t: string) => (t ? dayjs(t).format('YYYY-MM-DD HH:mm') : '-'),
    },
    {
      title: '操作',
      key: 'action',
      width: 100,
      render: (_: any, record: any) => (
        <Button type="link" size="small" icon={<CheckOutlined />} onClick={() => handleManualReview(record)}>
          人工复核
        </Button>
      ),
    },
  ];

  return (
    <div className="review-audit">
      <Title level={2}>评价审核与人工复核</Title>
      <Card>
        <Space style={{ marginBottom: 16 }} wrap>
          <Select
            placeholder="审核池"
            value={poolFilter || undefined}
            onChange={setPoolFilter}
            style={{ width: 140 }}
            allowClear
          >
            <Select.Option value="mandatory">必审池（L3-L4/奖励金&gt;800）</Select.Option>
            <Select.Option value="sample">抽检池（L1-L2 约5%）</Select.Option>
          </Select>
          <Select
            placeholder="审核结果"
            value={statusFilter || undefined}
            onChange={setStatusFilter}
            style={{ width: 120 }}
            allowClear
          >
            <Select.Option value="rejected">AI 不通过</Select.Option>
          </Select>
        </Space>
        <Table
          columns={columns}
          dataSource={list}
          loading={loading}
          rowKey="reviewId"
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

      <Modal
        title="人工复核"
        open={manualModalVisible}
        onOk={submitManualReview}
        onCancel={() => setManualModalVisible(false)}
      >
        {selectedReview && (
          <div style={{ marginBottom: 16 }}>
            <p>评价ID: {selectedReview.reviewId}</p>
            <p>订单ID: {selectedReview.orderId}</p>
            <p>内容: {selectedReview.content || '-'}</p>
            {selectedReview.missingItems && (
              <p>AI 标注缺项: {Array.isArray(selectedReview.missingItems) ? selectedReview.missingItems.join('; ') : String(selectedReview.missingItems)}</p>
            )}
          </div>
        )}
        <Space direction="vertical" style={{ width: '100%' }}>
          <div>
            <span style={{ marginRight: 8 }}>复核结果:</span>
            <Select value={manualResult} onChange={setManualResult} style={{ width: 120 }}>
              <Select.Option value="pass">通过</Select.Option>
              <Select.Option value="reject">不通过</Select.Option>
            </Select>
          </div>
          {manualResult === 'reject' && (
            <div>
              <span>缺项说明:</span>
              <TextArea rows={3} value={manualNote} onChange={(e) => setManualNote(e.target.value)} placeholder="填写不通过原因/缺项" />
            </div>
          )}
        </Space>
      </Modal>
    </div>
  );
}
