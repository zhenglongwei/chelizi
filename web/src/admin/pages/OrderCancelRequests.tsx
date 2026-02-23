import { useState, useEffect } from 'react';
import {
  Table,
  Card,
  Button,
  Space,
  Tag,
  Modal,
  message,
  Typography,
  Tooltip,
} from 'antd';
import { ReloadOutlined, CheckOutlined, CloseOutlined, ExclamationCircleOutlined } from '@ant-design/icons';
import { callCloudFunction } from '../utils/api';
import dayjs from 'dayjs';

const { Title } = Typography;

export default function OrderCancelRequests() {
  const [list, setList] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  useEffect(() => {
    loadList();
  }, []);

  const loadList = async () => {
    setLoading(true);
    try {
      const result = await callCloudFunction('getCancelRequests', {});
      if (result.success) {
        setList(result.data?.list || []);
      } else {
        message.error(result.message || '加载失败');
      }
    } catch (error: any) {
      console.error('加载撤单申请失败:', error);
      message.error('加载失败: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  const handleResolve = async (requestId: string, approve: boolean) => {
    setResolvingId(requestId);
    try {
      await callCloudFunction('resolveCancelRequest', { requestId, approve });
      message.success(approve ? '已同意撤单' : '已拒绝');
      loadList();
    } catch (error: any) {
      message.error('处理失败: ' + (error.message || '未知错误'));
    } finally {
      setResolvingId(null);
    }
  };

  const showConfirm = (requestId: string, approve: boolean) => {
    Modal.confirm({
      title: approve ? '同意撤单' : '拒绝撤单',
      icon: <ExclamationCircleOutlined />,
      content: approve
        ? '同意后订单将取消，竞价将重新开放，车主可重新选择其他报价。确定同意？'
        : '拒绝后订单保持原状态，车主可继续交易。确定拒绝？',
      okText: '确定',
      cancelText: '取消',
      onOk: () => handleResolve(requestId, approve),
    });
  };

  const columns = [
    {
      title: '申请ID',
      dataIndex: 'request_id',
      key: 'request_id',
      width: 120,
      ellipsis: true,
      render: (v: string) => (
        <Tooltip title={v}>
          <span>{v}</span>
        </Tooltip>
      ),
    },
    {
      title: '订单ID',
      dataIndex: 'order_id',
      key: 'order_id',
      width: 120,
      ellipsis: true,
      render: (v: string) => (
        <Tooltip title={v}>
          <span>{v}</span>
        </Tooltip>
      ),
    },
    {
      title: '车主ID',
      dataIndex: 'user_id',
      key: 'user_id',
      width: 100,
      ellipsis: true,
    },
    {
      title: '撤单理由',
      dataIndex: 'reason',
      key: 'reason',
      ellipsis: true,
      render: (v: string) => (
        <Tooltip title={v}>
          <span>{v || '-'}</span>
        </Tooltip>
      ),
    },
    {
      title: '报价金额',
      dataIndex: 'quoted_amount',
      key: 'quoted_amount',
      width: 100,
      render: (v: any) => (v != null ? `¥${Number(v).toFixed(2)}` : '-'),
    },
    {
      title: '提交人工时间',
      dataIndex: 'escalated_at',
      key: 'escalated_at',
      width: 170,
      render: (v: string) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '-'),
    },
    {
      title: '操作',
      key: 'action',
      width: 180,
      fixed: 'right' as const,
      render: (_: any, record: any) => {
        const resolving = resolvingId === record.request_id;
        return (
          <Space>
            <Button
              type="primary"
              size="small"
              icon={<CheckOutlined />}
              loading={resolving}
              onClick={() => showConfirm(record.request_id, true)}
            >
              同意撤单
            </Button>
            <Button
              size="small"
              danger
              icon={<CloseOutlined />}
              loading={resolving}
              onClick={() => showConfirm(record.request_id, false)}
            >
              拒绝
            </Button>
          </Space>
        );
      },
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Card>
        <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Title level={4} style={{ margin: 0 }}>
            撤单申请（已提交人工）
          </Title>
          <Button icon={<ReloadOutlined />} onClick={loadList} loading={loading}>
            刷新
          </Button>
        </div>
        <p style={{ color: '#666', marginBottom: 16 }}>
          车主申请撤单被服务商拒绝后，可提交人工通道。此处仅展示 status=3（已提交人工）的申请，由后台人员决定是否同意撤单。
        </p>
        <Table
          rowKey="request_id"
          columns={columns}
          dataSource={list}
          loading={loading}
          pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }}
          scroll={{ x: 900 }}
        />
      </Card>
    </div>
  );
}
