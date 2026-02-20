import { useState, useEffect } from 'react';
import {
  Table,
  Card,
  Button,
  Space,
  Tag,
  Modal,
  Form,
  Input,
  Select,
  message,
  Typography,
} from 'antd';
import {
  CheckOutlined,
  CloseOutlined,
  EyeOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { callCloudFunction } from '../utils/api';

const { Title } = Typography;
const { TextArea } = Input;

export default function MerchantManagement() {
  const [merchants, setMerchants] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [auditModalVisible, setAuditModalVisible] = useState(false);
  const [selectedMerchant, setSelectedMerchant] = useState<any>(null);
  const [qualificationFilter, setQualificationFilter] = useState<string>('');
  const [form] = Form.useForm();

  useEffect(() => {
    loadMerchants({ qualificationAuditStatus: qualificationFilter || undefined });
  }, [qualificationFilter]);

  const loadMerchants = async (params: any = {}) => {
    setLoading(true);
    try {
      const result = await callCloudFunction('getMerchants', {
        page: params.page || 1,
        pageSize: params.pageSize || 10,
        auditStatus: params.auditStatus,
        qualificationAuditStatus: params.qualificationAuditStatus,
        keyword: params.keyword
      });
      
      if (result.success) {
        setMerchants(result.data.list || []);
        // 可以保存分页信息用于分页组件
      } else {
        message.error(result.message || '加载服务商列表失败');
      }
    } catch (error: any) {
      console.error('加载服务商列表失败:', error);
      message.error(error.message || '加载服务商列表失败');
    } finally {
      setLoading(false);
    }
  };

  const handleAudit = (merchant: any) => {
    setSelectedMerchant(merchant);
    setAuditModalVisible(true);
    form.setFieldsValue({ auditStatus: 'approved' });
  };

  const handleAuditSubmit = async (values: any) => {
    try {
      if (!selectedMerchant || !selectedMerchant.merchantId) {
        message.error('服务商信息不完整');
        return;
      }

      const result = await callCloudFunction('qualificationAudit', {
        merchantId: selectedMerchant.merchantId,
        auditStatus: values.auditStatus,
        auditNote: values.auditNote,
      });

      if (result.success) {
        message.success(result.message || '资质审核成功');
        setAuditModalVisible(false);
        loadMerchants();
      } else {
        message.error(result.message || '审核失败');
      }
    } catch (error: any) {
      console.error('审核失败:', error);
      message.error(error.message || '审核失败');
    }
  };

  const getQualificationStatusConfig = (status: number | string) => {
    const s = status === 1 || status === '1' ? 'approved' : (status === 2 || status === '2' ? 'rejected' : 'pending');
    const map: any = {
      pending: { color: 'orange', text: '待审核' },
      approved: { color: 'green', text: '已通过' },
      rejected: { color: 'red', text: '已驳回' }
    };
    return map[s] || { color: 'default', text: '待审核' };
  };

  const columns = [
    { title: '服务商名称', dataIndex: 'merchantName', key: 'merchantName' },
    { title: '联系电话', dataIndex: 'phone', key: 'phone' },
    { title: '地址', dataIndex: 'address', key: 'address' },
    {
      title: '合规率',
      dataIndex: 'complianceRate',
      key: 'complianceRate',
      render: (v: number) => (v != null ? `${v}%` : '-'),
    },
    {
      title: '投诉率',
      dataIndex: 'complaintRate',
      key: 'complaintRate',
      render: (v: number) => (v != null ? `${v}%` : '-'),
    },
    {
      title: '资质等级',
      dataIndex: 'qualificationLevel',
      key: 'qualificationLevel',
      render: (v: string) => v || '-',
    },
    {
      title: '技师持证',
      dataIndex: 'technicianCerts',
      key: 'technicianCerts',
      render: (v: any) => {
        if (!v) return '-';
        const arr = Array.isArray(v) ? v : [];
        const parts = arr.map((t: any) => (typeof t === 'object' && t !== null) ? `${t.name || '未填'}(${t.level || '-'})` : String(t));
        return parts.length ? parts.join('、') : '-';
      },
    },
    {
      title: '资质状态',
      dataIndex: 'qualificationStatus',
      key: 'qualificationStatus',
      render: (status: number | string) => {
        const config = getQualificationStatusConfig(status);
        return <Tag color={config.color}>{config.text}</Tag>;
      },
    },
    {
      title: '待审核/驳回原因',
      dataIndex: 'qualificationAuditReason',
      key: 'qualificationAuditReason',
      ellipsis: true,
      render: (v: string, record: any) => {
        if (!v) return '-';
        const status = record.qualificationStatus;
        if (status === 0 || status === '0') return <span title={v}>{v}</span>;
        if (status === 2 || status === '2') return <span title={v} style={{ color: '#cf1322' }}>{v}</span>;
        return '-';
      },
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: any) => (
        <Space>
          <Button
            type="link"
            icon={<EyeOutlined />}
            onClick={() => handleViewDetail(record)}
          >
            查看详情
          </Button>
          {((record.qualificationStatus === 0 || record.qualificationStatus === '0' || record.qualificationStatus == null) || (record.qualificationStatus === 2 || record.qualificationStatus === '2')) && (record.qualificationLevel || (record.technicianCerts && record.technicianCerts.length)) && (
            <Button
              type="link"
              icon={<CheckOutlined />}
              onClick={() => handleAudit(record)}
            >
              资质审核
            </Button>
          )}
        </Space>
      ),
    },
  ];

  const formatTechnicianCerts = (certs: any) => {
    if (!certs) return '-';
    const arr = Array.isArray(certs) ? certs : [];
    const parts = arr.map((t: any) => (typeof t === 'object' && t !== null) ? `${t.name || '未填'}(${t.level || '-'})` : String(t));
    return parts.length ? parts.join('、') : '-';
  };

  const handleViewDetail = (merchant: any) => {
    const certsStr = formatTechnicianCerts(merchant.technicianCerts);
    const certifications = typeof merchant.certifications === 'string' ? (merchant.certifications ? JSON.parse(merchant.certifications) : []) : (merchant.certifications || []);
    const licenseCert = certifications.find((c: any) => c.type === 'license' || c.type === '营业执照');
    const qualCert = certifications.find((c: any) => c.type === 'qualification_cert');
    const canAudit = ((merchant.qualificationStatus === 0 || merchant.qualificationStatus === '0' || merchant.qualificationStatus == null) || (merchant.qualificationStatus === 2 || merchant.qualificationStatus === '2')) && (merchant.qualificationLevel || (merchant.technicianCerts && (Array.isArray(merchant.technicianCerts) ? merchant.technicianCerts.length : merchant.technicianCerts)));
    Modal.info({
      title: '服务商详情',
      width: 640,
      content: (
        <div>
          <p>服务商名称：{merchant.merchantName}</p>
          <p>联系电话：{merchant.phone}</p>
          <p>地址：{merchant.address}</p>
          <p>资质等级：{merchant.qualificationLevel || '-'}</p>
          <p>待审核原因：{merchant.qualificationAuditReason || '-'}</p>
          <p>AI识别结果：{merchant.qualificationAiResult === 'recognition_failed' ? '识别失败' : merchant.qualificationAiResult === 'no_qualification_found' ? '未识别到资质' : merchant.qualificationAiResult || '-'}</p>
          {(licenseCert?.image || qualCert?.image || (Array.isArray(merchant.technicianCerts) && merchant.technicianCerts.some((t: any) => t?.certificate_url))) && (
            <div style={{ marginTop: 12 }}>
              <p style={{ marginBottom: 8, fontWeight: 500 }}>资质证件图片（供审核参考）：</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                {licenseCert?.image && (
                  <div>
                    <p style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>营业执照</p>
                    <img src={typeof licenseCert.image === 'string' ? licenseCert.image : (licenseCert.image?.url || '')} alt="营业执照" style={{ width: 160, height: 120, objectFit: 'cover', borderRadius: 4, border: '1px solid #eee' }} />
                  </div>
                )}
                {qualCert?.image && (
                  <div>
                    <p style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>维修资质证明</p>
                    <img src={typeof qualCert.image === 'string' ? qualCert.image : (qualCert.image?.url || '')} alt="资质证明" style={{ width: 160, height: 120, objectFit: 'cover', borderRadius: 4, border: '1px solid #eee' }} />
                  </div>
                )}
                {Array.isArray(merchant.technicianCerts) && merchant.technicianCerts
                  .filter((t: any) => t?.certificate_url)
                  .map((t: any, i: number) => (
                    <div key={i}>
                      <p style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>技师证书 {i + 1}{t?.name ? `（${t.name}）` : ''}</p>
                      <img src={typeof t.certificate_url === 'string' ? t.certificate_url : ''} alt={`技师证书${i + 1}`} style={{ width: 160, height: 120, objectFit: 'cover', borderRadius: 4, border: '1px solid #eee' }} />
                    </div>
                  ))}
              </div>
            </div>
          )}
          <p style={{ marginTop: 12 }}>技师持证：{certsStr}</p>
          <p>合规率：{merchant.complianceRate != null ? `${merchant.complianceRate}%` : '-'}</p>
          <p>投诉率：{merchant.complaintRate != null ? `${merchant.complaintRate}%` : '-'}</p>
          {canAudit && (
            <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid #f0f0f0' }}>
              <Button type="primary" icon={<CheckOutlined />} onClick={() => { Modal.destroyAll(); handleAudit(merchant); }} style={{ marginRight: 8 }}>
                资质审核
              </Button>
            </div>
          )}
        </div>
      ),
    });
  };

  return (
    <div className="merchant-management">
      <Title level={2}>服务商管理</Title>
      <p style={{ marginBottom: 16, color: '#666' }}>注册免审，服务商需补充资质并通过审核后方可接单、展示。</p>
      <Space style={{ marginBottom: 16 }}>
        <span>资质筛选：</span>
        <Select
          value={qualificationFilter}
          onChange={setQualificationFilter}
          style={{ width: 140 }}
          placeholder="全部"
          allowClear
        >
          <Select.Option value="pending">资质待审核</Select.Option>
          <Select.Option value="approved">资质已通过</Select.Option>
          <Select.Option value="rejected">资质已驳回</Select.Option>
        </Select>
      </Space>
      <Card>
        <Table
          columns={columns}
          dataSource={merchants}
          loading={loading}
          rowKey="merchantId"
          pagination={{ pageSize: 10 }}
        />
      </Card>

      <Modal
        title="资质审核"
        open={auditModalVisible}
        onCancel={() => setAuditModalVisible(false)}
        onOk={() => form.submit()}
      >
        <Form form={form} onFinish={handleAuditSubmit} layout="vertical">
          <Form.Item
            name="auditStatus"
            label="审核结果"
            rules={[{ required: true, message: '请选择审核结果' }]}
          >
            <Select>
              <Select.Option value="approved">通过</Select.Option>
              <Select.Option value="rejected">驳回</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item
            name="auditNote"
            label="驳回原因（驳回时必填，将展示给服务商）"
            rules={[
              {
                validator: (_, value) => {
                  const status = form.getFieldValue('auditStatus');
                  if (status === 'rejected' && !(value && String(value).trim())) {
                    return Promise.reject(new Error('驳回时请填写原因'));
                  }
                  return Promise.resolve();
                },
              },
            ]}
          >
            <TextArea rows={4} placeholder="驳回时请填写原因，如：用户修改了技师职业等级，需人工复核" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

