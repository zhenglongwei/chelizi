import { useEffect, useMemo, useState } from 'react';
import { Card, Table, Button, message, Typography, Space, Image, Tag } from 'antd';
import api from '../utils/api';

const { Title, Text } = Typography;

type Row = {
  report_id: string;
  user_id: string;
  images: string[];
  user_description: string;
  analysis_attempts: number;
  analysis_error: string;
  created_at: string;
};

function normalizeUrlList(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
  return [];
}

function resolveMediaUrl(url: string): string {
  const u = (url || '').trim();
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  const apiBase = import.meta.env.VITE_API_BASE_URL || '';
  const origin =
    apiBase.replace(/\/api\/?$/i, '').replace(/\/$/, '') ||
    (typeof window !== 'undefined' ? window.location.origin : '');
  if (u.startsWith('//')) return `https:${u}`;
  if (u.startsWith('/')) return `${origin}${u}`;
  return u;
}

export default function DamageAnalysisManualReview() {
  const [list, setList] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState<string>('');

  const loadList = async () => {
    setLoading(true);
    try {
      const res = await api.get('/v1/admin/damage-analysis/manual-review');
      const inner = (res as any)?.data ?? res;
      setList((inner?.list || []).map((r: any) => ({ ...r, images: normalizeUrlList(r.images).map(resolveMediaUrl) })));
    } catch (e: any) {
      message.error(e.message || '加载失败');
      setList([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadList();
  }, []);

  const decide = async (reportId: string, relevance: 'relevant' | 'irrelevant') => {
    setSubmitting(reportId + ':' + relevance);
    try {
      await api.post(`/v1/admin/damage-analysis/reports/${reportId}/decision`, { relevance });
      message.success(relevance === 'relevant' ? '已通过并触发分发' : '已拒绝分发');
      await loadList();
    } catch (e: any) {
      message.error(e.message || '操作失败');
    } finally {
      setSubmitting('');
    }
  };

  const columns = useMemo(
    () => [
      {
        title: '报告ID',
        dataIndex: 'report_id',
        key: 'report_id',
        width: 220,
        render: (v: string) => <Text code>{v}</Text>,
      },
      {
        title: '用户',
        dataIndex: 'user_id',
        key: 'user_id',
        width: 140,
        render: (v: string) => <Text code>{v}</Text>,
      },
      {
        title: '图片',
        dataIndex: 'images',
        key: 'images',
        render: (urls: string[]) => {
          const list = Array.isArray(urls) ? urls : [];
          if (!list.length) return <Text type="secondary">无</Text>;
          const show = list.slice(0, 6);
          return (
            <Image.PreviewGroup>
              <Space wrap>
                {show.map((u, i) => (
                  <Image
                    key={u + i}
                    width={72}
                    height={72}
                    src={u}
                    style={{ objectFit: 'cover', borderRadius: 6 }}
                    referrerPolicy="no-referrer"
                  />
                ))}
                {list.length > show.length ? <Tag>+{list.length - show.length}</Tag> : null}
              </Space>
            </Image.PreviewGroup>
          );
        },
      },
      {
        title: '尝试/错误',
        key: 'err',
        width: 260,
        render: (_: any, r: Row) => (
          <div>
            <div>
              <Tag color="orange">{r.analysis_attempts || 0} 次</Tag>
            </div>
            <Text type="secondary">{(r.analysis_error || '').slice(0, 120) || '—'}</Text>
          </div>
        ),
      },
      {
        title: '操作',
        key: 'act',
        width: 220,
        render: (_: any, r: Row) => (
          <Space>
            <Button
              type="primary"
              loading={submitting === r.report_id + ':relevant'}
              onClick={() => decide(r.report_id, 'relevant')}
            >
              通过并分发
            </Button>
            <Button
              danger
              loading={submitting === r.report_id + ':irrelevant'}
              onClick={() => decide(r.report_id, 'irrelevant')}
            >
              拒绝
            </Button>
          </Space>
        ),
      },
    ],
    [submitting]
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card>
        <Title level={4} style={{ margin: 0 }}>
          定损图片相关性人工审核
        </Title>
        <Text type="secondary">
          AI 连续失败 3 次后进入此队列。人工判定 relevant/irrelevant，并决定是否触发竞价分发。
        </Text>
      </Card>

      <Card>
        <Table<Row>
          rowKey="report_id"
          loading={loading}
          columns={columns as any}
          dataSource={list}
          pagination={{ pageSize: 20 }}
        />
      </Card>
    </div>
  );
}

