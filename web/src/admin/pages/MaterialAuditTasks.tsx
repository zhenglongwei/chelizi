import { useState, useEffect } from 'react';
import { Card, Table, Button, message, Typography, Image, Space, Input, Drawer, Tag, Divider } from 'antd';
import { AuditOutlined } from '@ant-design/icons';
import api from '../utils/api';
import dayjs from 'dayjs';

const { Title, Text, Paragraph } = Typography;
const { TextArea } = Input;

type Evidence = {
  repair_photos?: unknown;
  settlement_photos?: unknown;
  material_photos?: unknown;
  lead_technician?: { name?: string };
};

function normalizeUrlList(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) {
    return v.filter((x) => typeof x === 'string' && x.trim()).map((x) => (x as string).trim());
  }
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}

function resolveMediaUrl(url: string): string {
  const u = (url || '').trim();
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  const apiBase = import.meta.env.VITE_API_BASE_URL || '';
  const origin = apiBase.replace(/\/api\/?$/i, '').replace(/\/$/, '') || (typeof window !== 'undefined' ? window.location.origin : '');
  if (u.startsWith('//')) return `https:${u}`;
  if (u.startsWith('/')) return `${origin}${u}`;
  return u;
}

function evidenceSummary(ev: Evidence | null | undefined) {
  if (!ev || typeof ev !== 'object') return { repair: [], settlement: [], material: [] };
  return {
    repair: normalizeUrlList(ev.repair_photos).map(resolveMediaUrl),
    settlement: normalizeUrlList(ev.settlement_photos).map(resolveMediaUrl),
    material: normalizeUrlList(ev.material_photos).map(resolveMediaUrl),
  };
}

function EvidenceGallery({ ev }: { ev: Evidence | null | undefined }) {
  const { repair, settlement, material } = evidenceSummary(ev);
  const total = repair.length + settlement.length + material.length;
  if (total === 0) {
    return (
      <div style={{ padding: 16, color: '#999', background: '#fafafa', borderRadius: 8 }}>
        暂无图片 URL（请确认 completion_evidence 中 repair_photos / settlement_photos / material_photos）
      </div>
    );
  }
  const w = 96;
  const renderGroup = (label: string, urls: string[]) => {
    if (!urls.length) return null;
    return (
      <div style={{ marginBottom: 20 }}>
        <div style={{ marginBottom: 10, fontWeight: 600 }}>
          {label}
          <Tag style={{ marginLeft: 8 }}>{urls.length} 张</Tag>
        </div>
        <Image.PreviewGroup>
          <Space wrap size="middle">
            {urls.map((url, i) => (
              <Image
                key={`${label}-${i}`}
                width={w}
                height={w}
                src={url}
                style={{ objectFit: 'cover', borderRadius: 6 }}
                referrerPolicy="no-referrer"
              />
            ))}
          </Space>
        </Image.PreviewGroup>
      </div>
    );
  };
  return (
    <div>
      {renderGroup('修复后照片', repair)}
      {renderGroup('定损单/结算单', settlement)}
      {renderGroup('物料照片', material)}
    </div>
  );
}

export default function MaterialAuditTasks() {
  const [list, setList] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailRecord, setDetailRecord] = useState<any>(null);
  const [rejectNote, setRejectNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    loadList();
  }, []);

  const loadList = async () => {
    setLoading(true);
    try {
      const res = await api.get('/v1/admin/material-audit-tasks');
      const inner = (res as any)?.data ?? res;
      setList(inner?.list || []);
    } catch (error: any) {
      message.error(error.message || '加载失败');
      setList([]);
    } finally {
      setLoading(false);
    }
  };

  const openDetail = (record: any) => {
    setDetailRecord(record);
    setRejectNote('');
    setDetailOpen(true);
  };

  const closeDetail = () => {
    setDetailOpen(false);
    setDetailRecord(null);
    setRejectNote('');
  };

  const submitApprove = async () => {
    if (!detailRecord) return;
    setSubmitting(true);
    try {
      await api.post(`/v1/admin/material-audit-tasks/${detailRecord.task_id}/resolve`, { approve: true });
      message.success('已通过材料质检（订单若已在待验收则仅更新质检结论）');
      closeDetail();
      loadList();
    } catch (error: any) {
      message.error(error.message || '操作失败');
    } finally {
      setSubmitting(false);
    }
  };

  const submitReject = async () => {
    if (!detailRecord) return;
    const note = rejectNote.trim();
    if (!note) {
      message.warning('驳回时请填写原因，将通知商户');
      return;
    }
    setSubmitting(true);
    try {
      await api.post(`/v1/admin/material-audit-tasks/${detailRecord.task_id}/resolve`, {
        approve: false,
        reject_reason: note,
      });
      message.success('已驳回，商户可重新提交');
      closeDetail();
      loadList();
    } catch (error: any) {
      message.error(error.message || '操作失败');
    } finally {
      setSubmitting(false);
    }
  };

  const columns = [
    { title: '任务ID', dataIndex: 'task_id', key: 'task_id', width: 200, ellipsis: true },
    { title: '店铺', dataIndex: 'shop_name', key: 'shop_name', width: 120, ellipsis: true },
    { title: '订单ID', dataIndex: 'order_id', key: 'order_id', width: 160, ellipsis: true },
    {
      title: '金额核验',
      key: 'amount_check',
      width: 220,
      render: (_: unknown, record: any) => {
        const expected = record?.expected_amount;
        const extracted = record?.extracted_amount;
        const diffRatio = record?.diff_ratio;
        const ok =
          expected != null &&
          extracted != null &&
          record?.diff_amount != null &&
          diffRatio != null &&
          !(Math.abs(Number(record.diff_amount)) > 1 && Number(diffRatio) > 1);
        const color = expected == null || extracted == null ? 'default' : ok ? 'green' : 'red';
        const expText = expected != null ? `¥${Number(expected).toFixed(2)}` : '—';
        const extText = extracted != null ? `¥${Number(extracted).toFixed(2)}` : '—';
        const ratioText = diffRatio != null ? `${Number(diffRatio).toFixed(2)}%` : '—';
        return (
          <div style={{ lineHeight: 1.4 }}>
            <Tag color={color} style={{ marginBottom: 4 }}>
              {expected == null || extracted == null ? '未提取' : ok ? '一致' : '不一致'}
            </Tag>
            <div style={{ fontSize: 12, color: '#666' }}>
              系统 {expText} / 识别 {extText}
            </div>
            <div style={{ fontSize: 12, color: '#888' }}>偏差 {ratioText}</div>
          </div>
        );
      },
    },
    {
      title: '凭证张数',
      key: 'evidence_counts',
      width: 130,
      render: (_: unknown, record: any) => {
        const { repair, settlement, material } = evidenceSummary(record.completion_evidence);
        return (
          <span style={{ fontSize: 13, color: '#666' }}>
            修复 {repair.length} · 结算 {settlement.length} · 物料 {material.length}
          </span>
        );
      },
    },
    {
      title: '参考说明（摘要）',
      dataIndex: 'reject_reason',
      key: 'reject_reason',
      ellipsis: true,
      render: (t: string) => t || '-',
    },
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
      width: 120,
      fixed: 'right' as const,
      render: (_: unknown, record: any) => (
        <Button type="primary" ghost size="small" icon={<AuditOutlined />} onClick={() => openDetail(record)}>
          审核
        </Button>
      ),
    },
  ];

  const r = detailRecord;

  return (
    <div style={{ padding: 24 }}>
      <Title level={2}>维修材料人工审核</Title>
      <Card>
        <Paragraph type="secondary" style={{ marginBottom: 16 }}>
          请先点击「审核」查看<strong>系统说明、AI 详情与全部凭证</strong>，确认无误后再在抽屉底部点击「通过」或「驳回」。列表仅作摘要，不替代完整审核。
          若图片无法加载，请检查 <code>VITE_API_BASE_URL</code> 与实际上传域名是否一致。
        </Paragraph>
        <Table
          columns={columns}
          dataSource={list}
          loading={loading}
          rowKey="task_id"
          scroll={{ x: 1000 }}
          pagination={false}
        />
      </Card>

      <Drawer
        title="材料审核 — 请核对后再处理"
        placement="right"
        width={Math.min(720, typeof window !== 'undefined' ? window.innerWidth - 24 : 720)}
        open={detailOpen}
        onClose={closeDetail}
        destroyOnClose
        footer={
          <div>
            <div style={{ marginBottom: 8, fontSize: 13, color: '#666' }}>驳回原因（仅点击「驳回」时必填，将推送给商户）</div>
            <TextArea
              rows={3}
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
              placeholder="通过时无需填写；驳回时请说明需补充或修改的要点"
              maxLength={500}
              showCount
              disabled={submitting}
            />
            <Space style={{ marginTop: 16, width: '100%', justifyContent: 'flex-end' }} wrap>
              <Button onClick={closeDetail} disabled={submitting}>
                关闭
              </Button>
              <Button danger onClick={submitReject} loading={submitting}>
                驳回
              </Button>
              <Button type="primary" onClick={submitApprove} loading={submitting}>
                通过
              </Button>
            </Space>
          </div>
        }
      >
        {r && (
          <div style={{ paddingBottom: 24 }}>
            <Title level={5} style={{ marginTop: 0 }}>
              任务信息
            </Title>
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <Text>
                <strong>任务ID</strong> {r.task_id}
              </Text>
              <Text>
                <strong>订单ID</strong> {r.order_id}
              </Text>
              <Text>
                <strong>店铺</strong> {r.shop_name || '-'}
              </Text>
              <Text>
                <strong>提交时间</strong> {r.created_at ? dayjs(r.created_at).format('YYYY-MM-DD HH:mm:ss') : '-'}
              </Text>
              {r.completion_evidence?.lead_technician?.name && (
                <Text>
                  <strong>负责技师</strong> {r.completion_evidence.lead_technician.name}
                </Text>
              )}
            </Space>

            <Divider />

            <Title level={5}>自动审核 / 系统说明</Title>
            <div
              style={{
                padding: 12,
                background: 'rgba(250, 173, 20, 0.08)',
                borderLeft: '4px solid #faad14',
                borderRadius: 4,
                marginBottom: 12,
              }}
            >
              <Text>{r.reject_reason || '（无单独说明，请结合下方 AI 详情与图片判断）'}</Text>
            </div>

            <Title level={5} style={{ marginTop: 0 }}>
              金额核验（结算单识别 vs 系统）
            </Title>
            <Space direction="vertical" size={4} style={{ width: '100%', marginBottom: 12 }}>
              <Text>
                <strong>系统金额</strong>{' '}
                {r.expected_amount != null ? `¥${Number(r.expected_amount).toFixed(2)}` : '—'}
              </Text>
              <Text>
                <strong>AI 识别结算金额</strong>{' '}
                {r.extracted_amount != null ? `¥${Number(r.extracted_amount).toFixed(2)}` : '—（未识别/未提取）'}
              </Text>
              <Text>
                <strong>差额</strong>{' '}
                {r.diff_amount != null ? `¥${Number(r.diff_amount).toFixed(2)}` : '—'}
                {r.diff_ratio != null ? `（偏差 ${Number(r.diff_ratio).toFixed(2)}%）` : ''}
              </Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                规则：差额 &gt; 1 元且偏差 &gt; 1% → 转人工核验
              </Text>
            </Space>

            {r.ai_details && Object.keys(r.ai_details).length > 0 && (
              <>
                <Text strong style={{ display: 'block', marginBottom: 8 }}>
                  AI 详情（原始结构）
                </Text>
                <pre
                  style={{
                    fontSize: 12,
                    maxHeight: 220,
                    overflow: 'auto',
                    padding: 12,
                    background: '#f5f5f5',
                    borderRadius: 8,
                    marginBottom: 16,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {JSON.stringify(r.ai_details, null, 2)}
                </pre>
              </>
            )}

            <Divider />

            <Title level={5}>服务商上传凭证</Title>
            <EvidenceGallery ev={r.completion_evidence} />
          </div>
        )}
      </Drawer>
    </div>
  );
}
