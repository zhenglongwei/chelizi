/**
 * 商品审核 - 服务商上架商品待审核列表
 */
import { useState, useEffect } from 'react';
import { Card, Table, Button, Space, Modal, Input, message } from 'antd';
import { CheckOutlined, CloseOutlined } from '@ant-design/icons';
import api from '../utils/api';

export default function ShopProductAudit() {
  const [list, setList] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [rejectModal, setRejectModal] = useState<{ productId: string } | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const loadList = async () => {
    setLoading(true);
    try {
      const res = await api.get('/v1/admin/shop-products/pending');
      const data = res?.data ?? res;
      setList(data?.list ?? []);
      setTotal(data?.total ?? 0);
    } catch (e: any) {
      message.error(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadList();
  }, []);

  const handleApprove = async (productId: string) => {
    try {
      await api.post(`/v1/admin/shop-products/${productId}/audit`, { action: 'approve' });
      message.success('已通过');
      loadList();
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
      loadList();
    } catch (e: any) {
      message.error(e?.message || '操作失败');
    }
  };

  const columns = [
    { title: '商品名称', dataIndex: 'name', key: 'name', width: 180 },
    { title: '分类', dataIndex: 'category', key: 'category', width: 100 },
    { title: '价格', dataIndex: 'price', key: 'price', width: 80, render: (v: number) => `¥${v}` },
    { title: '店铺', dataIndex: 'shop_name', key: 'shop_name', width: 150 },
    { title: '提交时间', dataIndex: 'created_at', key: 'created_at', width: 160 },
    {
      title: '操作',
      key: 'action',
      width: 160,
      render: (_: any, row: any) => (
        <Space>
          <Button type="primary" size="small" icon={<CheckOutlined />} onClick={() => handleApprove(row.product_id)}>
            通过
          </Button>
          <Button size="small" danger icon={<CloseOutlined />} onClick={() => setRejectModal({ productId: row.product_id })}>
            驳回
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Card title="待审核商品" loading={loading}>
        <Table
          dataSource={list}
          columns={columns}
          rowKey="product_id"
          pagination={{ total, pageSize: 20, showSizeChanger: true }}
        />
      </Card>
      <Modal
        title="驳回原因"
        open={!!rejectModal}
        onOk={handleReject}
        onCancel={() => { setRejectModal(null); setRejectReason(''); }}
        okText="确认驳回"
      >
        <Input.TextArea
          placeholder="选填，如：价格异常、描述不清晰"
          value={rejectReason}
          onChange={(e) => setRejectReason(e.target.value)}
          rows={3}
        />
      </Modal>
    </div>
  );
}
