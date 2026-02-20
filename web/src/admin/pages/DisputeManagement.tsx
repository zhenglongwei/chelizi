import { useState, useEffect } from 'react';
import {
  Table,
  Card,
  Button,
  Space,
  Tag,
  Modal,
  Form,
  Select,
  Input,
  message,
  Typography,
} from 'antd';
import { EyeOutlined, CheckOutlined } from '@ant-design/icons';
import { callCloudFunction } from '../utils/api';
import dayjs from 'dayjs';

const { Title } = Typography;
const { TextArea } = Input;

export default function DisputeManagement() {
  const [disputes, setDisputes] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [detailModalVisible, setDetailModalVisible] = useState(false);
  const [selectedDispute, setSelectedDispute] = useState<any>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    loadDisputes();
  }, []);

  const loadDisputes = async () => {
    setLoading(true);
    try {
      const result = await callCloudFunction('getComplaints', {});
      if (result.success) {
        setDisputes(result.data || []);
      } else {
        message.error(result.message || '加载投诉列表失败');
      }
    } catch (error: any) {
      console.error('加载投诉列表失败:', error);
      message.error('加载投诉列表失败: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  const handleViewDetail = (dispute: any) => {
    setSelectedDispute(dispute);
    setDetailModalVisible(true);
    form.setFieldsValue({ status: dispute.status });
  };

  const handleProcess = async (values: any) => {
    try {
      // 使用 updateData 更新投诉状态
      const result = await callCloudFunction('updateData', {
        collection: 'complaints',
        where: { _id: selectedDispute._id },
        data: {
          status: values.status,
          processNote: values.note || '',
          processorId: 'admin', // TODO: 从登录信息获取
          processTime: new Date().toISOString()
        }
      });
      
      if (result.success) {
        message.success('处理成功');
        setDetailModalVisible(false);
        loadDisputes();
      } else {
        message.error(result.message || '处理失败');
      }
    } catch (error: any) {
      console.error('处理失败:', error);
      message.error('处理失败: ' + error.message);
    }
  };

  const columns = [
    { title: '订单号', dataIndex: 'orderNo', key: 'orderNo' },
    { title: '车主', dataIndex: 'ownerName', key: 'ownerName' },
    { title: '服务商', dataIndex: 'merchantName', key: 'merchantName' },
    {
      title: '投诉类型',
      dataIndex: 'type',
      key: 'type',
      render: (type: string) => {
        const typeMap: any = {
          quality: '维修质量',
          price: '增项加价',
          service: '服务态度',
          other: '其他',
        };
        return typeMap[type] || type;
      },
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => {
        const statusMap: any = {
          pending: { color: 'orange', text: '待处理' },
          processing: { color: 'blue', text: '处理中' },
          resolved: { color: 'green', text: '已解决' },
          closed: { color: 'default', text: '已结案' },
        };
        const config = statusMap[status] || { color: 'default', text: status };
        return <Tag color={config.color}>{config.text}</Tag>;
      },
    },
    {
      title: '创建时间',
      dataIndex: 'createTime',
      key: 'createTime',
      render: (val: Date) => dayjs(val).format('YYYY-MM-DD HH:mm:ss'),
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
        </Space>
      ),
    },
  ];

  return (
    <div className="dispute-management">
      <Title level={2}>纠纷处理</Title>
      
      <Card>
        <Table
          columns={columns}
          dataSource={disputes}
          loading={loading}
          rowKey="_id"
          pagination={{ pageSize: 10 }}
        />
      </Card>

      <Modal
        title="投诉详情"
        open={detailModalVisible}
        onCancel={() => setDetailModalVisible(false)}
        onOk={() => form.submit()}
        width={600}
      >
        {selectedDispute && (
          <div style={{ marginBottom: 16 }}>
            <p><strong>订单号：</strong>{selectedDispute.orderNo}</p>
            <p><strong>投诉内容：</strong>{selectedDispute.description}</p>
          </div>
        )}
        <Form form={form} onFinish={handleProcess} layout="vertical">
          <Form.Item
            name="status"
            label="处理状态"
            rules={[{ required: true, message: '请选择处理状态' }]}
          >
            <Select>
              <Select.Option value="processing">处理中</Select.Option>
              <Select.Option value="resolved">已解决</Select.Option>
              <Select.Option value="closed">已结案</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="note" label="处理意见">
            <TextArea rows={4} placeholder="请输入处理意见" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

