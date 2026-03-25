/**
 * 商品审核 - 服务商上架商品待审核列表（含详情与自动/人工审核说明）
 */
import { useState, useEffect, useCallback } from 'react';
import {
  Card,
  Table,
  Button,
  Space,
  Modal,
  Input,
  message,
  Drawer,
  Descriptions,
  Typography,
  Image,
  Alert,
  Tooltip,
  Tag,
} from 'antd';
import { CheckOutlined, CloseOutlined, EyeOutlined } from '@ant-design/icons';
import api from '../utils/api';

type PendingProduct = {
  product_id: string;
  shop_id: string;
  shop_name: string;
  name: string;
  category: string;
  price: number;
  description: string | null;
  images: string[];
  status: string;
  audit_reason: string | null;
  created_at: string;
};

export default function ShopProductAudit() {
  const [list, setList] = useState<PendingProduct[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  const [rejectModal, setRejectModal] = useState<{ productId: string } | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [detail, setDetail] = useState<PendingProduct | null>(null);

  const loadList = useCallback(async (p: number, ps: number) => {
    setLoading(true);
    try {
      const res: any = await api.get('/v1/admin/shop-products/pending', {
        params: { page: p, limit: ps },
      });
      const data = res?.data ?? res;
      const raw = data?.list ?? [];
      setList(
        raw.map((r: any) => ({
          ...r,
          images: Array.isArray(r.images) ? r.images : [],
        }))
      );
      setTotal(data?.total ?? 0);
      setPage(data?.page ?? p);
      setPageSize(ps);
    } catch (e: any) {
      message.error(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadList(1, 20);
  }, [loadList]);

  const handleTableChange = (p: number, ps: number) => {
    void loadList(p, ps);
  };

  const handleApprove = async (productId: string) => {
    try {
      await api.post(`/v1/admin/shop-products/${productId}/audit`, { action: 'approve' });
      message.success('已通过');
      setDetail((d) => (d?.product_id === productId ? null : d));
      void loadList(page, pageSize);
    } catch (e: any) {
      message.error(e?.message || '操作失败');
    }
  };

  const handleReject = async () => {
    if (!rejectModal) return;
    try {
      await api.post(`/v1/admin/shop-products/${rejectModal.productId}/audit`, {
        action: 'reject',
        reason: rejectReason || '不符合上架要求',
      });
      message.success('已驳回');
      setRejectModal(null);
      setRejectReason('');
      setDetail((d) => (d?.product_id === rejectModal.productId ? null : d));
      void loadList(page, pageSize);
    } catch (e: any) {
      message.error(e?.message || '操作失败');
    }
  };

  const openReject = (productId: string) => {
    setRejectModal({ productId });
  };

  const auditReasonText = (reason: string | null | undefined) => {
    if (reason == null || String(reason).trim() === '') return null;
    return String(reason).trim();
  };

  const isAutoAuditNote = (reason: string | null | undefined) =>
    !!reason && String(reason).includes('[自动审核]');

  const columns = [
    { title: '商品名称', dataIndex: 'name', key: 'name', width: 160, ellipsis: true },
    { title: '分类', dataIndex: 'category', key: 'category', width: 96 },
    { title: '价格', dataIndex: 'price', key: 'price', width: 80, render: (v: number) => `¥${v}` },
    { title: '店铺', dataIndex: 'shop_name', key: 'shop_name', width: 140, ellipsis: true },
    {
      title: '审核说明',
      dataIndex: 'audit_reason',
      key: 'audit_reason',
      width: 200,
      ellipsis: true,
      render: (text: string | null) => {
        const t = auditReasonText(text);
        if (!t) {
          return <Typography.Text type="secondary">—</Typography.Text>;
        }
        const short = t.length > 48 ? `${t.slice(0, 48)}…` : t;
        return (
          <Tooltip title={t}>
            <Space size={4} wrap>
              {isAutoAuditNote(t) ? <Tag color="orange">自动</Tag> : null}
              <span>{short}</span>
            </Space>
          </Tooltip>
        );
      },
    },
    { title: '提交时间', dataIndex: 'created_at', key: 'created_at', width: 168 },
    {
      title: '操作',
      key: 'action',
      width: 220,
      fixed: 'right' as const,
      render: (_: unknown, row: PendingProduct) => (
        <Space wrap size="small">
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => setDetail(row)}>
            详情
          </Button>
          <Button type="primary" size="small" icon={<CheckOutlined />} onClick={() => handleApprove(row.product_id)}>
            通过
          </Button>
          <Button size="small" danger icon={<CloseOutlined />} onClick={() => openReject(row.product_id)}>
            驳回
          </Button>
        </Space>
      ),
    },
  ];

  const imgs = detail?.images?.filter(Boolean) ?? [];

  return (
    <div style={{ padding: 24 }}>
      <Card title="待审核商品">
        <Table<PendingProduct>
          dataSource={list}
          columns={columns}
          rowKey="product_id"
          loading={loading}
          scroll={{ x: 1100 }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (t) => `共 ${t} 条`,
            onChange: handleTableChange,
          }}
        />
      </Card>

      <Drawer
        title="商品审核详情"
        width={Math.min(720, typeof window !== 'undefined' ? window.innerWidth - 48 : 720)}
        open={!!detail}
        onClose={() => setDetail(null)}
        destroyOnClose
        extra={
          detail ? (
            <Space>
              <Button type="primary" icon={<CheckOutlined />} onClick={() => handleApprove(detail.product_id)}>
                通过
              </Button>
              <Button danger icon={<CloseOutlined />} onClick={() => openReject(detail.product_id)}>
                驳回
              </Button>
            </Space>
          ) : null
        }
      >
        {detail ? (
          <>
            {(() => {
              const reason = auditReasonText(detail.audit_reason);
              if (!reason) return null;
              return (
                <Alert
                  type={isAutoAuditNote(reason) ? 'warning' : 'info'}
                  showIcon
                  message={isAutoAuditNote(reason) ? '自动审核未通过说明' : '当前备注'}
                  description={
                    <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>
                      {reason}
                    </Typography.Paragraph>
                  }
                  style={{ marginBottom: 16 }}
                />
              );
            })()}

            <Descriptions bordered size="small" column={1} style={{ marginBottom: 16 }}>
              <Descriptions.Item label="商品 ID">{detail.product_id}</Descriptions.Item>
              <Descriptions.Item label="店铺 ID">{detail.shop_id}</Descriptions.Item>
              <Descriptions.Item label="店铺名称">{detail.shop_name}</Descriptions.Item>
              <Descriptions.Item label="商品名称">{detail.name}</Descriptions.Item>
              <Descriptions.Item label="分类">{detail.category}</Descriptions.Item>
              <Descriptions.Item label="价格">¥{detail.price}</Descriptions.Item>
              <Descriptions.Item label="提交时间">{detail.created_at}</Descriptions.Item>
            </Descriptions>

            <Typography.Title level={5}>商品描述</Typography.Title>
            <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>
              {detail.description?.trim() ? detail.description : (
                <Typography.Text type="secondary">未填写</Typography.Text>
              )}
            </Typography.Paragraph>

            <Typography.Title level={5} style={{ marginTop: 16 }}>
              商品配图（{imgs.length} 张）
            </Typography.Title>
            {imgs.length > 0 ? (
              <Image.PreviewGroup>
                <Space wrap size={[8, 8]}>
                  {imgs.map((src, i) => (
                    <Image
                      key={`${detail.product_id}-${i}`}
                      src={src}
                      alt={`配图 ${i + 1}`}
                      width={120}
                      height={120}
                      style={{ objectFit: 'cover', borderRadius: 4 }}
                    />
                  ))}
                </Space>
              </Image.PreviewGroup>
            ) : (
              <Typography.Text type="secondary">无配图</Typography.Text>
            )}
          </>
        ) : null}
      </Drawer>

      <Modal
        title="驳回原因"
        open={!!rejectModal}
        onOk={handleReject}
        onCancel={() => {
          setRejectModal(null);
          setRejectReason('');
        }}
        okText="确认驳回"
      >
        <Input.TextArea
          placeholder="选填，如：价格异常、描述不清晰"
          value={rejectReason}
          onChange={(e) => setRejectReason(e.target.value)}
          rows={4}
        />
      </Modal>
    </div>
  );
}
