import { useState, useEffect } from 'react';
import {
  Table,
  Card,
  Button,
  Space,
  Tag,
  Input,
  Select,
  DatePicker,
  message,
  Typography,
  Badge,
  Tooltip,
} from 'antd';
import { SearchOutlined, EyeOutlined, ReloadOutlined, ExclamationCircleOutlined } from '@ant-design/icons';
import { callCloudFunction } from '../utils/api';
import OrderDetailModal from '../components/OrderDetailModal';
import dayjs from 'dayjs';

const { Title } = Typography;
const { RangePicker } = DatePicker;

export default function OrderManagement() {
  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [selectedOrderNo, setSelectedOrderNo] = useState<string | null>(null);
  const [detailModalVisible, setDetailModalVisible] = useState(false);
  const [filters, setFilters] = useState({
    orderNo: '',
    status: '',
    ownerId: '',
    merchantId: '',
    dateRange: null as any,
  });

  useEffect(() => {
    loadOrders();
  }, [currentPage, pageSize]);

  const loadOrders = async () => {
    setLoading(true);
    try {
      const params: any = {
        page: currentPage,
        pageSize,
      };

      if (filters.orderNo) {
        params.orderNo = filters.orderNo;
      }

      if (filters.status) {
        params.status = filters.status;
      }

      if (filters.ownerId) {
        params.ownerId = filters.ownerId;
      }

      if (filters.merchantId) {
        params.merchantId = filters.merchantId;
      }

      if (filters.dateRange && filters.dateRange.length === 2) {
        params.startDate = filters.dateRange[0].format('YYYY-MM-DD');
        params.endDate = filters.dateRange[1].format('YYYY-MM-DD');
      }

      const result = await callCloudFunction('getAllOrders', params);
      
      if (result.success) {
        const ordersList = result.data.list || [];
        console.log('加载订单列表成功, 订单数量:', ordersList.length);
        // 检查订单数据
        if (ordersList.length > 0) {
          console.log('第一条订单数据:', ordersList[0]);
          console.log('第一条订单的 orderNo:', ordersList[0].orderNo);
        }
        setOrders(ordersList);
        setTotal(result.data.total || 0);
      } else {
        message.error(result.message || '加载订单列表失败');
      }
    } catch (error: any) {
      console.error('加载订单列表失败:', error);
      message.error('加载订单列表失败: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = () => {
    setCurrentPage(1);
    loadOrders();
  };

  const handleReset = () => {
    setFilters({
      orderNo: '',
      status: '',
      ownerId: '',
      merchantId: '',
      dateRange: null,
    });
    setCurrentPage(1);
    setTimeout(() => {
      loadOrders();
    }, 100);
  };

  const handleViewDetail = (orderNo: string) => {
    console.log('handleViewDetail 被调用, orderNo:', orderNo, '类型:', typeof orderNo);
    if (!orderNo || orderNo === '' || orderNo === null || orderNo === undefined) {
      console.error('订单号无效:', orderNo);
      message.error('订单号不能为空');
      return;
    }
    console.log('设置 selectedOrderNo:', orderNo);
    setSelectedOrderNo(orderNo);
    setDetailModalVisible(true);
  };

  const handleCloseDetail = () => {
    setDetailModalVisible(false);
    setSelectedOrderNo(null);
  };

  const getStatusConfig = (status: number | string) => {
    const map: Record<number, { color: string; text: string }> = {
      0: { color: 'orange', text: '待接单' },
      1: { color: 'blue', text: '维修中' },
      2: { color: 'purple', text: '待确认' },
      3: { color: 'green', text: '已完成' },
      4: { color: 'default', text: '已取消' },
    };
    const s = typeof status === 'string' ? parseInt(status, 10) : status;
    return map[s] || { color: 'default', text: String(status) };
  };

  const columns = [
    {
      title: '订单号',
      dataIndex: 'orderNo',
      key: 'orderNo',
      width: 160,
      render: (text: string) => <span style={{ fontFamily: 'monospace' }}>{text}</span>,
    },
    {
      title: '发起时间',
      dataIndex: 'createTime',
      key: 'createTime',
      width: 170,
      render: (time: string | Date) => time ? dayjs(time).format('YYYY-MM-DD HH:mm') : '-',
    },
    {
      title: '订单状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status: number | string) => {
        const config = getStatusConfig(status);
        return <Tag color={config.color}>{config.text}</Tag>;
      },
    },
    {
      title: '车主',
      dataIndex: 'ownerName',
      key: 'ownerName',
      width: 100,
      render: (v: string) => v || '-',
    },
    {
      title: '维修厂',
      dataIndex: 'merchantName',
      key: 'merchantName',
      width: 120,
      render: (v: string) => v || '-',
    },
    {
      title: '报价金额',
      dataIndex: 'orderAmount',
      key: 'orderAmount',
      width: 100,
      render: (val: number) => `¥${val || 0}`,
    },
    {
      title: '订单分级',
      dataIndex: 'orderTier',
      key: 'orderTier',
      width: 90,
      render: (tier: number) => {
        const tierMap: Record<number, string> = { 1: '一级', 2: '二级', 3: '三级', 4: '四级' };
        return tier != null ? (tierMap[tier] || `第${tier}级`) : '-';
      },
    },
    {
      title: '复杂度',
      dataIndex: 'complexityLevel',
      key: 'complexityLevel',
      width: 80,
      render: (v: string) => v || '-',
    },
    {
      title: '奖励金预估',
      dataIndex: 'rewardPreview',
      key: 'rewardPreview',
      width: 100,
      render: (val: number) => (val != null ? `¥${val}` : '-'),
    },
    {
      title: '操作',
      key: 'action',
      width: 100,
      fixed: 'right',
      render: (_: any, record: any) => {
        const orderNo = record.orderNo;
        return (
          <Button
            type="link"
            icon={<EyeOutlined />}
            onClick={() => {
              console.log('点击查看详情, record:', record);
              console.log('orderNo:', orderNo, '类型:', typeof orderNo);
              handleViewDetail(orderNo);
            }}
          >
            详情
          </Button>
        );
      },
    },
  ];

  return (
    <div className="order-management">
      <Title level={2}>订单管理</Title>
      
      <Card>
        <Space style={{ marginBottom: 16 }} wrap>
          <Input
            placeholder="订单号"
            value={filters.orderNo}
            onChange={(e) => setFilters({ ...filters, orderNo: e.target.value })}
            style={{ width: 200 }}
            allowClear
          />
          <Input
            placeholder="车主ID"
            value={filters.ownerId}
            onChange={(e) => setFilters({ ...filters, ownerId: e.target.value })}
            style={{ width: 200 }}
            allowClear
          />
          <Input
            placeholder="服务商ID"
            value={filters.merchantId}
            onChange={(e) => setFilters({ ...filters, merchantId: e.target.value })}
            style={{ width: 200 }}
            allowClear
          />
          <Select
            placeholder="订单状态"
            value={filters.status}
            onChange={(val) => setFilters({ ...filters, status: val })}
            style={{ width: 120 }}
            allowClear
          >
            <Select.Option value={0}>待接单</Select.Option>
            <Select.Option value={1}>维修中</Select.Option>
            <Select.Option value={2}>待确认</Select.Option>
            <Select.Option value={3}>已完成</Select.Option>
            <Select.Option value={4}>已取消</Select.Option>
          </Select>
          <RangePicker
            value={filters.dateRange}
            onChange={(dates) => setFilters({ ...filters, dateRange: dates })}
            format="YYYY-MM-DD"
          />
          <Button type="primary" icon={<SearchOutlined />} onClick={handleSearch}>
            搜索
          </Button>
          <Button icon={<ReloadOutlined />} onClick={handleReset}>
            重置
          </Button>
        </Space>

        <Table
          columns={columns}
          dataSource={orders}
          loading={loading}
          rowKey="orderNo"
          scroll={{ x: 900 }}
          pagination={{
            current: currentPage,
            pageSize: pageSize,
            total: total,
            showSizeChanger: true,
            showTotal: (total) => `共 ${total} 条`,
            onChange: (page, size) => {
              setCurrentPage(page);
              setPageSize(size || 20);
            },
          }}
        />
      </Card>

      {selectedOrderNo && (
        <OrderDetailModal
          visible={detailModalVisible}
          orderNo={selectedOrderNo}
          onClose={handleCloseDetail}
        />
      )}
    </div>
  );
}
