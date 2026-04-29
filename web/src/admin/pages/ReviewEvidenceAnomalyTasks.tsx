import { useState, useEffect } from 'react';
import { Card, Table, Button, message, Typography, Drawer, Space, Checkbox, Input } from 'antd';
import { SafetyCertificateOutlined } from '@ant-design/icons';
import api from '../utils/api';
import dayjs from 'dayjs';

const { Title, Paragraph, Text } = Typography;

export default function ReviewEvidenceAnomalyTasks() {
  const [list, setList] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [row, setRow] = useState<any>(null);
  const [submitting, setSubmitting] = useState(false);
  const [markInvalid, setMarkInvalid] = useState(false);
  const [resolutionNote, setResolutionNote] = useState('');

  useEffect(() => {
    loadList();
  }, []);

  const loadList = async () => {
    setLoading(true);
    try {
      const res = await api.get('/v1/admin/review-evidence-anomaly-tasks');
      const inner = (res as any)?.data ?? res;
      setList(inner?.list || []);
    } catch (e: any) {
      message.error(e.message || '加载失败');
      setList([]);
    } finally {
      setLoading(false);
    }
  };

  const openDetail = (r: any) => {
    setRow(r);
    setMarkInvalid(false);
    setResolutionNote('');
    setOpen(true);
  };

  const resolve = async (coeff: 0 | 1) => {
    if (!row) return;
    setSubmitting(true);
    try {
      const resolution = resolutionNote.trim() || (coeff === 1 ? 'dismiss_restore' : 'exclude_shop_score');
      await api.post(`/v1/admin/review-evidence-anomaly-tasks/${row.task_id}/resolve`, {
        evidence_alignment_coeff: coeff,
        resolution,
        mark_review_invalid: coeff === 0 ? markInvalid : false,
      });
      message.success('已结案');
      setOpen(false);
      setRow(null);
      loadList();
    } catch (e: any) {
      message.error(e.message || '操作失败');
    } finally {
      setSubmitting(false);
    }
  };

  const columns = [
    { title: '任务', dataIndex: 'task_id', key: 'task_id', width: 200, ellipsis: true },
    { title: '店铺', dataIndex: 'shop_name', key: 'shop_name', width: 120, ellipsis: true },
    { title: '订单', dataIndex: 'order_id', key: 'order_id', width: 160, ellipsis: true },
    { title: '评价', dataIndex: 'review_id', key: 'review_id', width: 160, ellipsis: true },
    {
      title: '触发',
      dataIndex: 'trigger_reason',
      key: 'trigger_reason',
      width: 160,
      render: (t: string) => (t === 'auto_extreme_negative' ? 'AI 正面 vs 评价极端负向' : t === 'auto_extreme_positive' ? 'AI 负面 vs 评价极端正向' : t || '-'),
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 170,
      render: (t: string) => (t ? dayjs(t).format('YYYY-MM-DD HH:mm') : '-'),
    },
    {
      title: '操作',
      key: 'act',
      width: 100,
      fixed: 'right' as const,
      render: (_: unknown, r: any) => (
        <Button type="primary" ghost size="small" icon={<SafetyCertificateOutlined />} onClick={() => openDetail(r)}>
          结案
        </Button>
      ),
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Title level={2}>评价—过程证据异常复核</Title>
      <Card>
        <Paragraph type="secondary" style={{ marginBottom: 16 }}>
          与《05》衔接：结案写入 <Text code>evidence_alignment_coeff</Text>（0/1）并重算店铺分；可选将评价标为无效（隐藏、不计店铺分）。不改变已发放基础轨现金。
        </Paragraph>
        <Table rowKey="task_id" loading={loading} dataSource={list} columns={columns} scroll={{ x: 1000 }} pagination={false} />
      </Card>

      <Drawer title="结案" width={560} open={open} onClose={() => !submitting && setOpen(false)} destroyOnClose>
        {row && (
          <div>
            <Paragraph>
              <Text strong>触发原因：</Text> {row.trigger_reason}
            </Paragraph>
            <Paragraph>
              <Text strong>AI 快照摘要（JSON）：</Text>
              <pre style={{ maxHeight: 200, overflow: 'auto', fontSize: 12, background: '#fafafa', padding: 8 }}>
                {JSON.stringify(row.ai_snapshot || {}, null, 2)}
              </pre>
            </Paragraph>
            <Paragraph>
              <Text strong>评价快照：</Text>
              <pre style={{ maxHeight: 160, overflow: 'auto', fontSize: 12, background: '#fafafa', padding: 8 }}>
                {JSON.stringify(row.review_snapshot || {}, null, 2)}
              </pre>
            </Paragraph>
            <Paragraph>
              <Text type="secondary">结案说明（写入 resolution，可选）</Text>
              <Input
                value={resolutionNote}
                onChange={(e) => setResolutionNote(e.target.value)}
                placeholder="如 R0 误解 / R2 诱导评价 等"
                style={{ marginTop: 8 }}
              />
            </Paragraph>
            <Paragraph>
              <Checkbox checked={markInvalid} onChange={(e) => setMarkInvalid(e.target.checked)} disabled={submitting}>
                同时将评价标为无效（content_quality=invalid，status=0）
              </Checkbox>
            </Paragraph>
            <Space style={{ marginTop: 24 }}>
              <Button type="primary" loading={submitting} onClick={() => resolve(1)}>
                恢复权重（系数 1）
              </Button>
              <Button danger loading={submitting} onClick={() => resolve(0)}>
                剔除口碑权重（系数 0）
              </Button>
            </Space>
          </div>
        )}
      </Drawer>
    </div>
  );
}
