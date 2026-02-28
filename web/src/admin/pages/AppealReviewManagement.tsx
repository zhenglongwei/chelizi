import { useState, useEffect } from 'react';
import {
  Card,
  Table,
  Button,
  Modal,
  Tag,
  message,
  Typography,
  Image,
  Space,
} from 'antd';
import { CheckOutlined, CloseOutlined } from '@ant-design/icons';
import api from '../utils/api';
import dayjs from 'dayjs';

const { Title } = Typography;

const QUESTION_LABELS: Record<string, string> = {
  q1_progress_synced: '维修进度是否与您同步',
  q2_parts_shown: '是否展示新旧配件',
  q3_fault_resolved: '车辆问题是否已完全解决',
};

export default function AppealReviewManagement() {
  const [list, setList] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [modalVisible, setModalVisible] = useState(false);
  const [selected, setSelected] = useState<any>(null);
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    loadList();
  }, [page, pageSize]);

  const loadList = async () => {
    setLoading(true);
    try {
      const res = await api.get('/v1/admin/appeal-reviews', { params: { page, limit: pageSize } });
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

  const handleResolve = (record: any, approved: boolean) => {
    setSelected({ ...record, resolvingApproved: approved });
    setModalVisible(true);
  };

  const submitResolve = async () => {
    if (!selected) return;
    setResolving(true);
    try {
      await api.post(`/v1/admin/appeal-reviews/${selected.request_id}/resolve`, {
        approved: selected.resolvingApproved,
      });
      message.success(selected.resolvingApproved ? '已通过' : '已驳回');
      setModalVisible(false);
      setSelected(null);
      loadList();
    } catch (error: any) {
      message.error(error.message || '操作失败');
    } finally {
      setResolving(false);
    }
  };

  const columns = [
    { title: '申诉ID', dataIndex: 'request_id', key: 'request_id', width: 180, ellipsis: true },
    { title: '店铺', dataIndex: 'shop_name', key: 'shop_name', width: 120, ellipsis: true },
    {
      title: '申诉题目',
      dataIndex: 'question_label',
      key: 'question_label',
      width: 180,
      render: (v: string, r: any) => v || QUESTION_LABELS[r.question_key] || r.question_key,
    },
    { title: '订单ID', dataIndex: 'order_id', key: 'order_id', width: 140, ellipsis: true },
    {
      title: '提交时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 170,
      render: (t: string) => (t ? dayjs(t).format('YYYY-MM-DD HH:mm') : '-'),
    },
    {
      title: '操作',
      key: 'action',
      width: 180,
      render: (_: any, record: any) => (
        <Space>
          <Button type="link" size="small" icon={<CheckOutlined />} onClick={() => handleResolve(record, true)}>
            通过
          </Button>
          <Button type="link" size="small" danger icon={<CloseOutlined />} onClick={() => handleResolve(record, false)}>
            驳回
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div className="appeal-review-management">
      <Title level={2}>商户申诉人工复核</Title>
      <Card>
        <p className="text-muted" style={{ marginBottom: 16 }}>
          AI 初审无法明确判断的申诉会转入待人工复核，预计 3 个工作日内处理。
        </p>
        <Table
          columns={columns}
          dataSource={list}
          loading={loading}
          rowKey="request_id"
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
        title={selected?.resolvingApproved ? '确认通过' : '确认驳回'}
        open={modalVisible}
        onOk={submitResolve}
        onCancel={() => setModalVisible(false)}
        confirmLoading={resolving}
        okText={selected?.resolvingApproved ? '通过' : '驳回'}
        okButtonProps={selected?.resolvingApproved ? {} : { danger: true }}
      >
        {selected && (
          <div style={{ maxHeight: 400, overflow: 'auto' }}>
            <p><strong>申诉ID:</strong> {selected.request_id}</p>
            <p><strong>店铺:</strong> {selected.shop_name}</p>
            <p><strong>题目:</strong> {selected.question_label || QUESTION_LABELS[selected.question_key]}</p>
            <p><strong>订单ID:</strong> {selected.order_id}</p>
            <p><strong>评价内容:</strong> {selected.review_content || '-'}</p>
            <p><strong>评分:</strong> {selected.rating ?? '-'}</p>
            {selected.evidence_urls && selected.evidence_urls.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <strong>申诉材料:</strong>
                <Image.PreviewGroup>
                  <Space wrap style={{ marginTop: 8 }}>
                    {(selected.evidence_urls as string[]).map((url, i) => (
                      <Image key={i} width={80} height={80} src={url} style={{ objectFit: 'cover' }} />
                    ))}
                  </Space>
                </Image.PreviewGroup>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
