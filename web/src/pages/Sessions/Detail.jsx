import { useEffect, useState } from 'react';
import { Table, Tag, Button, Space, Modal, Form, Input, message, Popconfirm } from 'antd';
import { ArrowLeftOutlined, EditOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { useParams, useNavigate } from 'react-router-dom';
import { getSessionLogs } from '../../services/session';
import { createLog, updateLog, deleteLog } from '../../services/log';
import dayjs from 'dayjs';

export default function SessionDetail() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingLog, setEditingLog] = useState(null);
  const [form] = Form.useForm();

  useEffect(() => { loadLogs(); }, [sessionId]);

  async function loadLogs() {
    setLoading(true);
    try {
      const res = await getSessionLogs(sessionId, { pageSize: 500 });
      if (res.ok && res.data) {
        const logs = Array.isArray(res.data) ? res.data : res.data.data || [];
        setData(logs.slice().reverse());
      }
    } catch (_) {}
    setLoading(false);
  }

  function handleAdd() {
    setEditingLog(null);
    form.resetFields();
    setModalVisible(true);
  }

  function handleEdit(record) {
    setEditingLog(record);
    form.setFieldsValue(record);
    setModalVisible(true);
  }

  async function handleDelete(id) {
    try {
      await deleteLog(id);
      message.success('删除成功');
      loadLogs();
    } catch (_) {
      message.error('删除失败');
    }
  }

  async function handleSubmit() {
    try {
      const values = await form.validateFields();
      if (editingLog) {
        await updateLog(editingLog.id, values);
        message.success('更新成功');
      } else {
        await createLog(values);
        message.success('创建成功');
      }
      setModalVisible(false);
      loadLogs();
    } catch (_) {}
  }

  const columns = [
    { title: '#', key: 'index', width: 50, render: (_, __, i) => data.length - i },
    { title: '时间', dataIndex: 'time', key: 'time', width: 80 },
    { title: '主控', dataIndex: 'controller', key: 'controller', width: 100 },
    { title: '呼号', dataIndex: 'callsign', key: 'callsign', width: 100 },
    { title: '报告', dataIndex: 'report', key: 'report', width: 60 },
    { title: 'QTH', dataIndex: 'qth', key: 'qth', width: 120 },
    { title: '设备', dataIndex: 'device', key: 'device', width: 100 },
    { title: '功率', dataIndex: 'power', key: 'power', width: 80 },
    { title: '天线', dataIndex: 'antenna', key: 'antenna', width: 100 },
    { title: '高度', dataIndex: 'height', key: 'height', width: 80 },
    {
      title: '操作', key: 'action', width: 140,
      render: (_, r) => (
        <Space>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(r)}>编辑</Button>
          <Popconfirm title="确定删除？" onConfirm={() => handleDelete(r.id)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/sessions')}>返回</Button>
          <h1 style={{ fontSize: 24, margin: 0 }}>Session 详情</h1>
        </Space>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>添加日志</Button>
      </div>
      <Table
        dataSource={data}
        columns={columns}
        rowKey={(r) => r.id || r.sync_id}
        loading={loading}
        size="small"
        pagination={{ pageSize: 50, showSizeChanger: true, pageSizeOptions: ['20', '50', '100', '200'] }}
      />

      <Modal
        title={editingLog ? '编辑日志' : '添加日志'}
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        onOk={handleSubmit}
        width={600}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="time" label="时间" rules={[{ required: true }]}>
            <Input placeholder="HH:MM" />
          </Form.Item>
          <Form.Item name="controller" label="主控" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="callsign" label="呼号" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="report" label="报告">
            <Input />
          </Form.Item>
          <Form.Item name="qth" label="QTH">
            <Input />
          </Form.Item>
          <Form.Item name="device" label="设备">
            <Input />
          </Form.Item>
          <Form.Item name="power" label="功率">
            <Input />
          </Form.Item>
          <Form.Item name="antenna" label="天线">
            <Input />
          </Form.Item>
          <Form.Item name="height" label="高度">
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
