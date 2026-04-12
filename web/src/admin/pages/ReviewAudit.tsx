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
  Image,
  Form,
  Switch,
  InputNumber,
} from 'antd';
import { CheckOutlined } from '@ant-design/icons';
import api from '../utils/api';
import dayjs from 'dayjs';

const { Title, Paragraph } = Typography;
const { TextArea } = Input;

const API_ORIGIN = String(import.meta.env.VITE_API_BASE_URL || '').replace(/\/?api\/?$/i, '');

function absMediaUrl(u: string) {
  if (!u || typeof u !== 'string') return '';
  const s = u.trim();
  if (s.startsWith('http')) return s;
  return API_ORIGIN ? `${API_ORIGIN}${s.startsWith('/') ? s : `/${s}`}` : s;
}

/** 千问返回、供运营审核的未达标摘要与要点（存于 ai_analysis.ai_details.operationsReview） */
function extractOperationsReviewFromAi(ai: Record<string, unknown> | null | undefined): {
  summary: string;
  items: string[];
} | null {
  if (!ai || typeof ai !== 'object') return null;
  const ad = ai.ai_details;
  const d = ad && typeof ad === 'object' ? (ad as Record<string, unknown>) : {};
  const op = d.operationsReview;
  if (!op || typeof op !== 'object') return null;
  const o = op as Record<string, unknown>;
  const summary = String(o.summary || '').trim();
  const items = Array.isArray(o.notMetItems)
    ? o.notMetItems.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  if (!summary && !items.length) return null;
  return { summary, items };
}

function contentQualityLabel(cq: string | null | undefined) {
  if (cq === 'pending_human') return '待人工裁定';
  if (cq === 'invalid') return '无效';
  if (cq === 'premium') return '优质';
  if (cq === 'valid') return '有效';
  if (cq === '标杆') return '标杆';
  if (cq === '维权参考') return '维权参考';
  return cq || '-';
}

/** 优先用接口下发的 ratingReasonDetail（含主因、指引、来源）；否则本地解析 ai_analysis */
function ratingReasonText(record: any): string {
  const detail = record?.ratingReasonDetail;
  if (detail != null && String(detail).trim() !== '') return String(detail);

  const raw = record?.aiAnalysis ?? record?.aianalysis ?? record?.ai_analysis;
  if (raw == null || raw === '') {
    if (record?.contentQuality === 'invalid') {
      return (
        '无效评价：未拉取到 ai_analysis 主因。请刷新列表或检查接口字段；历史数据可能未写入原因。'
      );
    }
    return '-';
  }
  let parsed: any = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return String(raw).slice(0, 400);
    }
  }
  if (parsed?.pending_human_audit) {
    const rr = String(parsed.reject_reason || parsed.primary_reason || '').trim();
    const hints = Array.isArray(parsed.improvement_hints) ? parsed.improvement_hints.join('；') : '';
    const ad = parsed.ai_details && typeof parsed.ai_details === 'object' ? parsed.ai_details : {};
    const op = ad.operationsReview && typeof ad.operationsReview === 'object' ? ad.operationsReview : null;
    const opBits: string[] = [];
    if (op) {
      const sum = String(op.summary || '').trim();
      const items = Array.isArray(op.notMetItems)
        ? op.notMetItems.map((x: string) => String(x || '').trim()).filter(Boolean)
        : [];
      if (sum) opBits.push(`运营摘要：${sum}`);
      if (items.length) opBits.push(`未达标要点：${items.join('；')}`);
    }
    return ['【待人工裁定·千问】', rr, hints, ...opBits].filter(Boolean).join(' ');
  }
  if (parsed?.invalid_submission) {
    const src = parsed.source ? `〔来源：${parsed.source}〕` : '';
    const parts = [
      parsed.primary_reason,
      ...(Array.isArray(parsed.improvement_hints) ? parsed.improvement_hints : []),
    ].filter(Boolean);
    const body = parts.join('；') || '-';
    return src ? `${src} ${body}` : body;
  }
  const cqReason = parsed?.contentQuality?.reason || parsed?.contentQuality?.explain || parsed?.rejectReason;
  if (cqReason) return String(cqReason);
  const qual = parsed?.contentQuality?.quality;
  if (qual) return `AI 内容档位：${qual}`;
  return '-';
}

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
  const [humanModalVisible, setHumanModalVisible] = useState(false);
  const [humanRecord, setHumanRecord] = useState<any>(null);
  const [humanRejectNote, setHumanRejectNote] = useState('');
  const [humanSubmitting, setHumanSubmitting] = useState(false);
  const [starAiCfgModalOpen, setStarAiCfgModalOpen] = useState(false);
  const [starAiCfgLoading, setStarAiCfgLoading] = useState(false);
  const [starAiCfgSaving, setStarAiCfgSaving] = useState(false);
  const [starAiCfgForm] = Form.useForm();

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

  const openHumanModal = (record: any) => {
    setHumanRecord(record);
    setHumanRejectNote('');
    setHumanModalVisible(true);
  };

  const submitHumanResolve = async (decision: 'approve' | 'reject') => {
    if (!humanRecord?.reviewId) return;
    if (decision === 'reject' && !humanRejectNote.trim()) {
      message.warning('裁定无效时请填写说明');
      return;
    }
    setHumanSubmitting(true);
    try {
      await api.post(`/v1/admin/review-audit/${humanRecord.reviewId}/pending-human-resolve`, {
        decision,
        note: decision === 'reject' ? humanRejectNote.trim() : undefined,
      });
      message.success(decision === 'approve' ? '已裁定有效并发奖' : '已裁定无效');
      setHumanModalVisible(false);
      setHumanRecord(null);
      loadList();
    } catch (error: any) {
      message.error(error.message || '操作失败');
    } finally {
      setHumanSubmitting(false);
    }
  };

  const collectReviewImages = (record: any): { label: string; url: string }[] => {
    const out: { label: string; url: string }[] = [];
    const setu = record?.settlementListImage || record?.settlement_list_image;
    if (setu) out.push({ label: '结算单', url: absMediaUrl(String(setu)) });
    const comp = record?.completionImageUrls || [];
    (Array.isArray(comp) ? comp : []).forEach((u: string, i: number) => {
      if (u) out.push({ label: `完工图${i + 1}`, url: absMediaUrl(String(u)) });
    });
    const aft = record?.afterImageUrls || [];
    (Array.isArray(aft) ? aft : []).forEach((u: string, i: number) => {
      if (u && !comp.includes(u)) out.push({ label: `追评/附图${i + 1}`, url: absMediaUrl(String(u)) });
    });
    const fe = record?.faultEvidenceUrls || [];
    (Array.isArray(fe) ? fe : []).forEach((u: string, i: number) => {
      if (u) out.push({ label: `故障举证${i + 1}`, url: absMediaUrl(String(u)) });
    });
    return out.filter((x) => x.url);
  };

  const parseAiForHuman = (record: any) => {
    let p = record?.aiAnalysis ?? record?.aianalysis;
    if (typeof p === 'string') {
      try {
        p = JSON.parse(p);
      } catch {
        return {};
      }
    }
    return p && typeof p === 'object' ? p : {};
  };

  const openStarAiCfgModal = async () => {
    setStarAiCfgModalOpen(true);
    setStarAiCfgLoading(true);
    try {
      const res = await api.get('/v1/admin/review-audit/star-ai-anomaly-config');
      const data = res?.data ?? res;
      starAiCfgForm.setFieldsValue({
        enabled: data.enabled !== false,
        userLowMax: data.userLowMax ?? 2,
        userHighMin: data.userHighMin ?? 4,
        quotePctGoodMax: data.quotePctGoodMax ?? 8,
        quotePctBadMin: data.quotePctBadMin ?? 18,
        repairGoodMin: data.repairGoodMin ?? 72,
        repairBadMax: data.repairBadMax ?? 45,
      });
    } catch (error: any) {
      message.error(error.message || '加载配置失败');
    } finally {
      setStarAiCfgLoading(false);
    }
  };

  const saveStarAiCfg = async () => {
    try {
      const values = await starAiCfgForm.validateFields();
      setStarAiCfgSaving(true);
      await api.put('/v1/admin/review-audit/star-ai-anomaly-config', values);
      message.success('已保存');
      setStarAiCfgModalOpen(false);
    } catch (error: any) {
      if (error?.errorFields) return;
      message.error(error?.message || '保存失败');
    } finally {
      setStarAiCfgSaving(false);
    }
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
      title: '展示',
      dataIndex: 'reviewStatus',
      key: 'reviewStatus',
      width: 72,
      render: (s: number) => (
        <Tag color={s === 1 ? 'blue' : 'default'}>{s === 1 ? '前台展示' : '未展示'}</Tag>
      ),
    },
    {
      title: '内容等级',
      key: 'contentGrade',
      width: 120,
      render: (_: unknown, record: any) => {
        const lv = record.contentQualityLevel != null ? `${record.contentQualityLevel}级` : '-';
        const lb = contentQualityLabel(record.contentQuality);
        return (
          <span>
            {lv} / {lb}
          </span>
        );
      },
    },
    {
      title: '审核关注',
      key: 'auditFlags',
      width: 168,
      render: (_: unknown, record: any) => (
        <Space wrap size={4}>
          {record.hasStarAiAnomaly ? (
            <Tag color="magenta" title={record.starAiAnomalyBrief || '星级与系统侧归纳反差，建议人工查看'}>
              星级-AI矛盾
            </Tag>
          ) : null}
          {record.hasAiAlignmentDivergence ? (
            <Tag color="orange" title={record.userAiAlignmentBrief || '车主表示与系统归纳不一致'}>
              不认可归纳
            </Tag>
          ) : null}
          {!record.hasStarAiAnomaly && !record.hasAiAlignmentDivergence ? (
            <span style={{ color: '#999' }}>—</span>
          ) : null}
        </Space>
      ),
    },
    {
      title: '评级说明',
      key: 'ratingReason',
      width: 300,
      ellipsis: { showTitle: false },
      render: (_: unknown, record: any) => {
        const full = ratingReasonText(record);
        if (!full || full === '-') return '-';
        return (
          <Paragraph
            ellipsis={{
              rows: 2,
              expandable: true,
              symbol: '展开',
            }}
            style={{ marginBottom: 0, maxWidth: 280, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
          >
            {full}
          </Paragraph>
        );
      },
    },
    {
      title: '审核结果',
      dataIndex: 'auditResult',
      key: 'auditResult',
      width: 90,
      render: (r: string, record: any) => (
        <Tag
          color={
            r === 'pass' ? 'green' : r === 'reject' ? 'red' : r === 'pending' ? 'orange' : 'default'
          }
        >
          {r === 'pass' ? '通过' : r === 'reject' ? '不通过' : r === 'pending' ? '待裁定' : '-'}
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
      width: 140,
      render: (_: any, record: any) =>
        record.contentQuality === 'pending_human' ? (
          <Button type="link" size="small" onClick={() => openHumanModal(record)}>
            AI驳回裁定
          </Button>
        ) : (
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
          <Button onClick={openStarAiCfgModal}>星级-AI 矛盾阈值</Button>
          <Select
            placeholder="审核池"
            value={poolFilter || undefined}
            onChange={setPoolFilter}
            style={{ width: 140 }}
            allowClear
          >
            <Select.Option value="mandatory">必审池（L3-L4/奖励金&gt;800）</Select.Option>
            <Select.Option value="sample">抽检池（L1-L2 约5%）</Select.Option>
            <Select.Option value="human_ai_pending">AI驳回·待人工裁定</Select.Option>
            <Select.Option value="ai_divergence">车主不认可归纳（对齐分歧）</Select.Option>
            <Select.Option value="star_ai_anomaly">星级 vs AI 自动矛盾</Select.Option>
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
          onRow={(record) =>
            record.hasStarAiAnomaly || record.hasAiAlignmentDivergence
              ? { style: { background: 'rgba(255, 77, 79, 0.04)' } }
              : {}
          }
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
        title="星级 vs 系统/AI 矛盾检测（极简 v3 提交时写入 review_system_checks）"
        open={starAiCfgModalOpen}
        onCancel={() => !starAiCfgSaving && setStarAiCfgModalOpen(false)}
        onOk={saveStarAiCfg}
        confirmLoading={starAiCfgSaving}
        okText="保存"
        width={560}
        destroyOnClose
      >
        <Paragraph type="secondary" style={{ marginBottom: 16 }}>
          关闭「启用」后新提交评价不再写入 star_ai_anomaly；已入库记录不变。数值保存时会自动理顺（如高星阈值须大于低星上界）。
        </Paragraph>
        <Form form={starAiCfgForm} layout="vertical" disabled={starAiCfgLoading}>
          <Form.Item label="启用自动检测" name="enabled" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item
            label="低星上界（≤此星且 AI 侧为正向 → 标矛盾）"
            name="userLowMax"
            rules={[{ required: true, message: '必填' }]}
          >
            <InputNumber min={1} max={4} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            label="高星下界（≥此星且 AI 侧为负向 → 标矛盾）"
            name="userHighMin"
            rules={[{ required: true, message: '必填' }]}
          >
            <InputNumber min={2} max={5} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            label="报价偏离：百分数 ≤ 视为「好」（与 level=low 并列）"
            name="quotePctGoodMax"
            rules={[{ required: true, message: '必填' }]}
          >
            <InputNumber min={0} max={100} addonAfter="%" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            label="报价偏离：百分数 &gt; 视为「差」（与 level=high 并列）"
            name="quotePctBadMin"
            rules={[{ required: true, message: '必填' }]}
          >
            <InputNumber min={0} max={100} addonAfter="%" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            label="外观修复度 ≥ 视为 AI 正向"
            name="repairGoodMin"
            rules={[{ required: true, message: '必填' }]}
          >
            <InputNumber min={0} max={100} addonAfter="%" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            label="外观修复度 ≤ 视为 AI 负向"
            name="repairBadMax"
            rules={[{ required: true, message: '必填' }]}
          >
            <InputNumber min={0} max={100} addonAfter="%" style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

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
            <p>
              内容等级:{' '}
              {selectedReview.contentQualityLevel != null ? `${selectedReview.contentQualityLevel}级` : '-'} /{' '}
              {contentQualityLabel(selectedReview.contentQuality)}
            </p>
            <p>评级说明: {ratingReasonText(selectedReview)}</p>
            {selectedReview.missingItems && (
              <p>AI 标注缺项: {Array.isArray(selectedReview.missingItems) ? selectedReview.missingItems.join('; ') : String(selectedReview.missingItems)}</p>
            )}
            {(selectedReview.quoteTransparencyStar != null ||
              selectedReview.repairEffectStar != null ||
              selectedReview.partsTraceabilityStar != null) && (
              <p>
                极简四维星：报价 {selectedReview.quoteTransparencyStar ?? '—'}★ / 修复{' '}
                {selectedReview.repairEffectStar ?? '—'}★ / 配件 {selectedReview.partsTraceabilityStar ?? '—'}★
              </p>
            )}
            {selectedReview.hasStarAiAnomaly &&
              Array.isArray(selectedReview.starAiAnomalyItems) &&
              selectedReview.starAiAnomalyItems.length > 0 && (
                <Card size="small" title="星级与系统/AI 归纳反差（自动标注）" style={{ marginTop: 12, background: '#fff7f0' }}>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {selectedReview.starAiAnomalyItems.map((it: any, idx: number) => (
                      <li key={idx} style={{ marginBottom: 6 }}>
                        {String(it?.summary || it?.label || '—')}
                      </li>
                    ))}
                  </ul>
                </Card>
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

      <Modal
        title="AI 驳回 — 人工裁定"
        open={humanModalVisible}
        onCancel={() => !humanSubmitting && setHumanModalVisible(false)}
        width={720}
        footer={null}
        destroyOnClose
      >
        {humanRecord && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <div>
              <Typography.Text strong>评价ID：</Typography.Text> {humanRecord.reviewId}
              <br />
              <Typography.Text strong>订单ID：</Typography.Text> {humanRecord.orderId}
            </div>
            <div>
              <Typography.Text strong>车主正文</Typography.Text>
              <Paragraph style={{ marginBottom: 0 }}>{humanRecord.content || '（无）'}</Paragraph>
            </div>
            {humanRecord.hasStarAiAnomaly &&
              Array.isArray(humanRecord.starAiAnomalyItems) &&
              humanRecord.starAiAnomalyItems.length > 0 && (
                <Card size="small" title="星级与系统侧归纳反差（自动标注）" style={{ background: '#fff7f0' }}>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {humanRecord.starAiAnomalyItems.map((it: any, idx: number) => (
                      <li key={idx} style={{ marginBottom: 6 }}>
                        {String(it?.summary || it?.label || '—')}
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            <div>
              <Typography.Text strong>AI 驳回理由</Typography.Text>
              <Paragraph type="warning" style={{ marginBottom: 0 }}>
                {String(parseAiForHuman(humanRecord).reject_reason || parseAiForHuman(humanRecord).primary_reason || '—')}
              </Paragraph>
            </div>
            {(() => {
              const op = extractOperationsReviewFromAi(parseAiForHuman(humanRecord));
              if (!op) return null;
              return (
                <Card size="small" title="千问未达标说明（运营审阅）" style={{ background: '#fafafa' }}>
                  {op.summary ? (
                    <Paragraph style={{ marginBottom: op.items.length ? 8 : 0 }}>
                      <Typography.Text strong>综合摘要：</Typography.Text> {op.summary}
                    </Paragraph>
                  ) : null}
                  {op.items.length > 0 ? (
                    <div>
                      <Typography.Text strong>未达标要点：</Typography.Text>
                      <ol style={{ margin: '8px 0 0 0', paddingLeft: 20 }}>
                        {op.items.map((t) => (
                          <li key={t}>{t}</li>
                        ))}
                      </ol>
                    </div>
                  ) : null}
                </Card>
              );
            })()}
            <div>
              <Typography.Text strong>改进建议（系统生成）</Typography.Text>
              <Paragraph style={{ marginBottom: 0 }}>
                {(parseAiForHuman(humanRecord).improvement_hints || []).join('；') || '—'}
              </Paragraph>
            </div>
            <div>
              <Typography.Text strong>AI 原始 details（JSON）</Typography.Text>
              <pre
                style={{
                  maxHeight: 200,
                  overflow: 'auto',
                  fontSize: 12,
                  background: '#f5f5f5',
                  padding: 8,
                  borderRadius: 4,
                }}
              >
                {JSON.stringify(parseAiForHuman(humanRecord).ai_details || {}, null, 2)}
              </pre>
            </div>
            <div>
              <Typography.Text strong>评价图片（请核对是否与订单、描述一致）</Typography.Text>
              <div style={{ marginTop: 8 }}>
                {collectReviewImages(humanRecord).length ? (
                  <Image.PreviewGroup>
                    {collectReviewImages(humanRecord).map((item) => (
                      <div key={item.url + item.label} style={{ display: 'inline-block', marginRight: 8, marginBottom: 8 }}>
                        <Image width={120} height={90} src={item.url} style={{ objectFit: 'cover' }} />
                        <div className="text-muted" style={{ fontSize: 12 }}>
                          {item.label}
                        </div>
                      </div>
                    ))}
                  </Image.PreviewGroup>
                ) : (
                  <Typography.Text type="secondary">无图片 URL</Typography.Text>
                )}
              </div>
            </div>
            <div>
              <Typography.Text strong>裁定无效时说明（必填）</Typography.Text>
              <TextArea
                rows={2}
                value={humanRejectNote}
                onChange={(e) => setHumanRejectNote(e.target.value)}
                placeholder="记录为何维持无效，便于追溯"
              />
            </div>
            <Space wrap>
              <Button type="primary" loading={humanSubmitting} onClick={() => submitHumanResolve('approve')}>
                裁定有效（发奖并前台展示）
              </Button>
              <Button danger loading={humanSubmitting} onClick={() => submitHumanResolve('reject')}>
                裁定无效（不发奖）
              </Button>
            </Space>
          </Space>
        )}
      </Modal>
    </div>
  );
}
