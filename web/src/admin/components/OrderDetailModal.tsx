import { Modal, Descriptions, Tabs, Table, Tag, Image, Timeline, Space, Button, message } from 'antd';
import { EyeOutlined, CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useState, useEffect } from 'react';
import { callCloudFunction } from '../utils/api';

const { TabPane } = Tabs;

interface OrderDetailModalProps {
  visible: boolean;
  orderNo: string;
  onClose: () => void;
}

export default function OrderDetailModal({ visible, orderNo, onClose }: OrderDetailModalProps) {
  const [loading, setLoading] = useState(false);
  const [orderDetail, setOrderDetail] = useState<any>(null);

  useEffect(() => {
    console.log('OrderDetailModal useEffect, visible:', visible, 'orderNo:', orderNo);
    if (visible && orderNo) {
      loadOrderDetail();
    } else if (visible && !orderNo) {
      console.error('OrderDetailModal: visible 为 true 但 orderNo 为空');
      message.error('订单号不能为空');
      onClose();
    }
  }, [visible, orderNo]);

  const loadOrderDetail = async () => {
    if (!orderNo) {
      console.error('OrderDetailModal: orderNo 为空', orderNo);
      message.error('订单号不能为空');
      return;
    }
    
    setLoading(true);
    try {
      console.log('OrderDetailModal: 准备调用 getOrderDetail, orderNo:', orderNo);
      const result = await callCloudFunction('getOrderDetail', { orderNo });
      console.log('OrderDetailModal: 收到结果', result);
      if (result.success) {
        setOrderDetail(result.data);
      } else {
        message.error(result.message || '获取订单详情失败');
        console.error('OrderDetailModal: 获取失败', result);
      }
    } catch (error: any) {
      console.error('OrderDetailModal: 调用异常', error);
      message.error('获取订单详情失败: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  if (!visible) return null;

  if (!orderDetail || !orderDetail.order) {
    return (
      <Modal title={`订单详情 - ${orderNo}`} open={visible} onCancel={onClose} footer={null} confirmLoading={loading}>
        <div style={{ textAlign: 'center', padding: 40 }}>{loading ? '加载中...' : '暂无订单数据'}</div>
      </Modal>
    );
  }

  const { order, ownerInfo, quotes, repairOrder, selectedMerchantInfo, refunds, complaints, review, settlementProofs } = orderDetail;
  const vi = order.vehicleInfo || {};

  // 报价表格列
  const quoteColumns = [
    {
      title: '服务商',
      dataIndex: 'merchantName',
      key: 'merchantName',
    },
    {
      title: '报价类型',
      dataIndex: 'quoteType',
      key: 'quoteType',
      render: (type: string) => {
        const typeMap: any = {
          'oem': '原厂件',
          'non-oem': '非原厂件',
          'both': '原厂+非原厂'
        };
        return <Tag color={type === 'non-oem' ? 'green' : 'blue'}>{typeMap[type] || type}</Tag>;
      }
    },
    {
      title: '报价金额',
      key: 'amount',
      render: (_: any, record: any) => {
        if (record.quoteType === 'oem' && record.oemQuote) {
          return `¥${record.oemQuote.totalAmount || 0}`;
        } else if (record.quoteType === 'non-oem' && record.nonOemQuote) {
          return `¥${record.nonOemQuote.totalAmount || 0}`;
        } else if (record.quoteType === 'both') {
          return (
            <div>
              <div>原厂: ¥{record.oemQuote?.totalAmount || 0}</div>
              <div>非原厂: ¥{record.nonOemQuote?.totalAmount || 0}</div>
            </div>
          );
        }
        return '-';
      }
    },
    {
      title: '配件明细',
      key: 'parts',
      render: (_: any, record: any) => {
        const parts = record.quoteType === 'oem' ? record.oemQuote : record.nonOemQuote;
        if (!parts) return '-';
        return (
          <div>
            <div>配件费: ¥{parts.partsCost || 0}</div>
            <div>工时费: ¥{parts.laborCost || 0}</div>
            <div>辅料费: ¥{parts.materialCost || 0}</div>
          </div>
        );
      }
    },
    {
      title: '附加服务',
      key: 'additionalServices',
      render: (_: any, record: any) => {
        const services = record.additionalServices || [];
        if (services.length === 0) return '无';
        return services.map((s: any) => (
          <Tag key={s.type} color="purple">
            {s.type === 'tow' ? '拖车' : s.type === 'loaner' ? '代步车' : s.type}
          </Tag>
        ));
      }
    },
    {
      title: '提交时间',
      dataIndex: 'submitTime',
      key: 'submitTime',
      render: (time: Date) => dayjs(time).format('YYYY-MM-DD HH:mm:ss'),
    },
    {
      title: '审核状态',
      dataIndex: 'auditStatus',
      key: 'auditStatus',
      render: (status: string) => {
        if (status == null || status === undefined) return '-';
        const statusMap: any = {
          'pending': { color: 'orange', text: '待审核' },
          'approved': { color: 'green', text: '已通过' },
          'rejected': { color: 'red', text: '已驳回' }
        };
        const config = statusMap[status] || { color: 'default', text: status };
        return <Tag color={config.color}>{config.text}</Tag>;
      }
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: any) => {
        if (record.auditStatus === 'pending') {
          return (
            <Space>
              <Button
                size="small"
                type="link"
                icon={<CheckCircleOutlined />}
                onClick={() => handleAuditQuote(record._id, 'approved')}
              >
                通过
              </Button>
              <Button
                size="small"
                type="link"
                danger
                icon={<CloseCircleOutlined />}
                onClick={() => handleAuditQuote(record._id, 'rejected')}
              >
                驳回
              </Button>
            </Space>
          );
        }
        return record.auditNote || '-';
      }
    }
  ];

  const handleAuditQuote = async (quoteId: string, auditStatus: string) => {
    try {
      const result = await callCloudFunction('auditQuote', {
        quoteId,
        auditStatus,
        auditorId: 'admin' // TODO: 从登录信息获取
      });
      if (result.success) {
        message.success(result.message);
        loadOrderDetail();
      } else {
        message.error(result.message || '审核失败');
      }
    } catch (error: any) {
      message.error('审核失败: ' + error.message);
    }
  };

  // 奖励金记录表格列
  const refundColumns = [
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
      render: (type: string) => {
        const typeMap: any = {
          'order': '订单奖励金',
          'referral': '裂变奖励金'
        };
        return typeMap[type] || type;
      }
    },
    {
      title: '奖励金金额',
      dataIndex: 'amount',
      key: 'amount',
      render: (amount: number) => `¥${amount || 0}`,
    },
    {
      title: '订单分级',
      dataIndex: 'reward_tier',
      key: 'reward_tier',
      render: (tier: number) => (tier != null ? ['一级', '二级', '三级', '四级'][tier - 1] : '-'),
    },
    {
      title: '评价阶段',
      dataIndex: 'review_stage',
      key: 'review_stage',
      render: (stage: string) => {
        const stageMap: any = { main: '主评价', '1m': '1个月追评', '3m': '3个月追评' };
        return stageMap[stage] || stage || '-';
      }
    },
    {
      title: '代扣个税',
      dataIndex: 'tax_deducted',
      key: 'tax_deducted',
      render: (v: number) => (v != null && v > 0 ? `¥${v}` : '-'),
    },
    {
      title: '支付状态',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => {
        const statusMap: any = {
          'pending': { color: 'orange', text: '待支付' },
          'paid': { color: 'green', text: '已支付' },
          'failed': { color: 'red', text: '支付失败' }
        };
        const config = statusMap[status] || { color: 'default', text: status };
        return <Tag color={config.color}>{config.text}</Tag>;
      }
    },
    {
      title: '支付时间',
      dataIndex: 'payTime',
      key: 'payTime',
      render: (time: Date) => time ? dayjs(time).format('YYYY-MM-DD HH:mm:ss') : '-',
    },
    {
      title: '创建时间',
      dataIndex: 'createTime',
      key: 'createTime',
      render: (time: Date) => dayjs(time).format('YYYY-MM-DD HH:mm:ss'),
    }
  ];

  // 投诉记录表格列
  const complaintColumns = [
    {
      title: '投诉类型',
      dataIndex: 'type',
      key: 'type',
      render: (type: string) => {
        const typeMap: any = {
          'quality': '维修质量',
          'price': '增项加价',
          'service': '服务态度',
          'other': '其他'
        };
        return typeMap[type] || type;
      }
    },
    {
      title: '投诉内容',
      dataIndex: 'content',
      key: 'content',
    },
    {
      title: '处理状态',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => {
        const statusMap: any = {
          'pending': { color: 'orange', text: '待处理' },
          'processing': { color: 'blue', text: '处理中' },
          'resolved': { color: 'green', text: '已解决' },
          'closed': { color: 'default', text: '已结案' }
        };
        const config = statusMap[status] || { color: 'default', text: status };
        return <Tag color={config.color}>{config.text}</Tag>;
      }
    },
    {
      title: '提交时间',
      dataIndex: 'createTime',
      key: 'createTime',
      render: (time: Date) => dayjs(time).format('YYYY-MM-DD HH:mm:ss'),
    }
  ];

  return (
    <Modal
      title={`订单详情 - ${orderNo}`}
      open={visible}
      onCancel={onClose}
      footer={null}
      width={1200}
      confirmLoading={loading}
    >
      <Tabs defaultActiveKey="basic">
        {/* 基本信息 */}
        <TabPane tab="基本信息" key="basic">
          <Descriptions column={2} bordered>
            <Descriptions.Item label="订单号">{order.orderNo}</Descriptions.Item>
            <Descriptions.Item label="订单状态">
              <Tag color={
                order.status === 3 ? 'green' :
                order.status === 4 ? 'red' :
                order.status === 1 ? 'blue' :
                order.status === 2 ? 'purple' : 'orange'
              }>
                {order.status === 0 ? '待接单' :
                 order.status === 1 ? '维修中' :
                 order.status === 2 ? '待确认' :
                 order.status === 3 ? '已完成' :
                 order.status === 4 ? '已取消' : String(order.status)}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="发起时间">
              {(order.createTime || order.createdAt) ? dayjs(order.createTime || order.createdAt).format('YYYY-MM-DD HH:mm:ss') : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="报价金额">
              ¥{order.quotedAmount || 0}
            </Descriptions.Item>
            <Descriptions.Item label="订单分级">
              {order.orderTier != null ? ['一级', '二级', '三级', '四级'][order.orderTier - 1] || `第${order.orderTier}级` : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="复杂度等级">
              {order.complexityLevel || '-'}
            </Descriptions.Item>
            <Descriptions.Item label="奖励金预估">
              {order.rewardPreview != null ? `¥${order.rewardPreview}` : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="佣金比例">
              {order.commissionRate != null ? `${Number(order.commissionRate)}%` : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="车主信息" span={2}>
              {ownerInfo ? (
                <div>
                  <div>昵称: {ownerInfo.nickName || ownerInfo.nickname || '-'}</div>
                  <div>手机: {ownerInfo.phone || '-'}</div>
                </div>
              ) : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="车辆信息" span={2}>
              <div>
                <div>品牌: {vi.brand || '-'}</div>
                <div>型号: {vi.model || '-'}</div>
                <div>车牌: {vi.plate_number || vi.plateNumber || '-'}</div>
              </div>
            </Descriptions.Item>
          </Descriptions>
        </TabPane>

        {/* 报价信息 */}
        <TabPane tab="报价信息" key="quotes">
          <Table
            columns={quoteColumns}
            dataSource={quotes || []}
            rowKey={(r) => r.quote_id || r._id || String(Math.random())}
            pagination={false}
            size="small"
          />
        </TabPane>

        {/* 成交信息 */}
        <TabPane tab="成交信息" key="deal">
          {repairOrder ? (
            <Descriptions column={2} bordered>
              <Descriptions.Item label="成交服务商">
                {selectedMerchantInfo?.name || repairOrder.merchantName}
              </Descriptions.Item>
              <Descriptions.Item label="报价类型">
                {repairOrder.selectedQuote?.type === 'oem' ? '原厂件' : '非原厂件'}
              </Descriptions.Item>
              <Descriptions.Item label="报价金额">
                ¥{repairOrder.selectedQuote?.totalAmount || 0}
              </Descriptions.Item>
              <Descriptions.Item label="最终定损金额">
                ¥{repairOrder.finalSettlement?.finalAmount || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="增项金额">
                ¥{repairOrder.finalSettlement?.additionalAmount || 0}
              </Descriptions.Item>
              <Descriptions.Item label="平台佣金">
                ¥{repairOrder.finalSettlement?.commission?.platform || 0}
              </Descriptions.Item>
              <Descriptions.Item label="车主返现">
                ¥{repairOrder.finalSettlement?.commission?.ownerRefund || 0}
              </Descriptions.Item>
              <Descriptions.Item label="结算时间">
                {repairOrder.finalSettlement?.settlementTime ?
                  dayjs(repairOrder.finalSettlement.settlementTime).format('YYYY-MM-DD HH:mm:ss') : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="维修进度" span={2}>
                <Timeline>
                  {(repairOrder.progress?.steps || []).map((step: any, index: number) => (
                    <Timeline.Item
                      key={index}
                      color={step.status === 'completed' ? 'green' : 'gray'}
                    >
                      {step.step} - {step.status === 'completed' ? '已完成' : '待完成'}
                      {step.time && ` (${dayjs(step.time).format('YYYY-MM-DD HH:mm:ss')})`}
                    </Timeline.Item>
                  ))}
                </Timeline>
              </Descriptions.Item>
              <Descriptions.Item label="增项明细" span={2}>
                {(repairOrder.additionalItems || []).length > 0 ? (
                  <Table
                    columns={[
                      { title: '增项内容', dataIndex: 'item', key: 'item' },
                      { title: '金额', dataIndex: 'amount', key: 'amount', render: (val: number) => `¥${val}` },
                      { title: '状态', dataIndex: 'status', key: 'status' },
                      { title: '申请时间', dataIndex: 'applyTime', key: 'applyTime', render: (time: Date) => dayjs(time).format('YYYY-MM-DD HH:mm:ss') }
                    ]}
                    dataSource={repairOrder.additionalItems}
                    rowKey="item"
                    pagination={false}
                    size="small"
                  />
                ) : '无增项'}
              </Descriptions.Item>
            </Descriptions>
          ) : (
            <div>暂无成交信息</div>
          )}
        </TabPane>

        {/* 奖励金记录 */}
        <TabPane tab="奖励金记录" key="refunds">
          <Table
            columns={refundColumns}
            dataSource={refunds || []}
            rowKey="_id"
            pagination={false}
            size="small"
          />
          {(!refunds || refunds.length === 0) && <div style={{ textAlign: 'center', padding: 20 }}>暂无奖励金记录</div>}
        </TabPane>

        {/* 投诉建议 */}
        <TabPane tab="投诉建议" key="complaints">
          <Table
            columns={complaintColumns}
            dataSource={complaints || []}
            rowKey="_id"
            pagination={false}
            size="small"
          />
          {(!complaints || complaints.length === 0) && <div style={{ textAlign: 'center', padding: 20 }}>暂无投诉记录</div>}
        </TabPane>

        {/* 评价信息 */}
        <TabPane tab="评价信息" key="review">
          {review ? (
            <Descriptions column={2} bordered>
              <Descriptions.Item label="评分">
                {review.rating || '-'} 星
              </Descriptions.Item>
              <Descriptions.Item label="评价时间">
                {dayjs(review.createTime).format('YYYY-MM-DD HH:mm:ss')}
              </Descriptions.Item>
              <Descriptions.Item label="评价内容" span={2}>
                {review.content || '-'}
              </Descriptions.Item>
            </Descriptions>
          ) : (
            <div style={{ textAlign: 'center', padding: 20 }}>暂无评价</div>
          )}
        </TabPane>

        {/* 定损证明材料 */}
        <TabPane tab="定损材料" key="proofs">
          {settlementProofs && settlementProofs.length > 0 ? (
            <div>
              {settlementProofs.map((proof: any, index: number) => (
                <div key={index} style={{ marginBottom: 16 }}>
                  <div><strong>{proof.title || `材料 ${index + 1}`}</strong></div>
                  <div>{proof.description || ''}</div>
                  {proof.files && proof.files.length > 0 && (
                    <Image.PreviewGroup>
                      {proof.files.map((file: string, fileIndex: number) => (
                        <Image
                          key={fileIndex}
                          width={100}
                          height={100}
                          src={file}
                          style={{ marginRight: 8, marginTop: 8 }}
                        />
                      ))}
                    </Image.PreviewGroup>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: 20 }}>暂无定损材料</div>
          )}
        </TabPane>
      </Tabs>
    </Modal>
  );
}

