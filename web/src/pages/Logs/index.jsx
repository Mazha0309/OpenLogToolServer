import { useEffect, useState } from 'react';
import { Table, Button, Modal, Form, Input, message, Space, Select } from 'antd';
import { getLogs, createLog, updateLog, deleteLog } from '../../services/log';
import { getUsers } from '../../services/admin';
import dayjs from 'dayjs';

const { TextArea } = Input;

function Logs() {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 });
  const [modalVisible, setModalVisible] = useState(false);
  const [editingLog, setEditingLog] = useState(null);
  const [form] = Form.useForm();
  const [users, setUsers] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState(null);

  useEffect(() => {
    loadUsers();
  }, []);

  useEffect(() => {
    loadLogs();
  }, [pagination.current, selectedUserId]);

  const loadUsers = async () => {
    try {
      const result = await getUsers();
      if (result.success) {
        const subAccounts = result.data.filter(u => u.role === 'user');
        setUsers(subAccounts);
      }
    } catch (error) {
      console.error('加载用户失败', error);
    }
  };

  const loadLogs = async () => {
    setLoading(true);
    try {
      const params = { page: pagination.current, pageSize: pagination.pageSize };
      if (selectedUserId) params.userId = selectedUserId;
      const result = await getLogs(params);
      if (result.success) {
        setData(result.data.data);
        setPagination(prev => ({ ...prev, total: result.data.total }));
      }
    } catch (error) {
      message.error('加载失败');
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = () => {
    setEditingLog(null);
    form.resetFields();
    setModalVisible(true);
  };

  const handleEdit = (record) => {
    setEditingLog(record);
    form.setFieldsValue(record);
    setModalVisible(true);
  };

  const handleDelete = async (id) => {
    try {
      const result = await deleteLog(id);
      if (result.success) {
        message.success('删除成功');
        loadLogs();
      }
    } catch (error) {
      message.error('删除失败');
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      if (editingLog) {
        await updateLog(editingLog.id, values);
      } else {
        await createLog(values);
      }
      message.success(editingLog ? '更新成功' : '创建成功');
      setModalVisible(false);
      loadLogs();
    } catch (error) {
      message.error('操作失败');
    }
  };

  const renderLogTime = (time) => {
    if (!time) return '-';

    const raw = String(time).trim();
    const parsed = dayjs(raw);
    if (parsed.isValid()) {
      return parsed.format('YYYY-MM-DD HH:mm');
    }

    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(raw)) {
      return raw;
    }

    return raw;
  };

  const columns = [
    { title: '时间', dataIndex: 'time', key: 'time', render: renderLogTime },
    { title: '控制员', dataIndex: 'controller', key: 'controller' },
    { title: '呼号', dataIndex: 'callsign', key: 'callsign' },
    { title: '报告', dataIndex: 'report', key: 'report' },
    { title: '位置', dataIndex: 'qth', key: 'qth' },
    { title: '设备', dataIndex: 'device', key: 'device' },
    { title: '功率', dataIndex: 'power', key: 'power' },
    { title: '天线', dataIndex: 'antenna', key: 'antenna' },
    { title: '操作', key: 'action', render: (_, record) => (
      <Space>
        <Button size="small" onClick={() => handleEdit(record)}>编辑</Button>
        <Button size="small" danger onClick={() => handleDelete(record.id)}>删除</Button>
      </Space>
    )},
  ];

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 24, marginBottom: 24 }}>日志管理</h1>
      <div style={{ marginBottom: 16, display: 'flex', gap: 12, alignItems: 'center' }}>
        <Select
          placeholder="选择子账号查看"
          allowClear
          style={{ width: 200 }}
          value={selectedUserId}
          onChange={(value) => {
            setSelectedUserId(value);
            setPagination(prev => ({ ...prev, current: 1 }));
          }}
          options={users.map(u => ({ label: u.username, value: u.id }))}
        />
        <span style={{ color: '#888', fontSize: 12 }}>
          {selectedUserId ? '查看子账号数据' : '查看所有数据'}
        </span>
      </div>
      <Button type="primary" onClick={handleAdd} style={{ marginBottom: 16 }}>添加日志</Button>
      <Table
        columns={columns}
        dataSource={data}
        loading={loading}
        rowKey="id"
        pagination={{
          current: pagination.current,
          pageSize: pagination.pageSize,
          total: pagination.total,
          onChange: (page) => setPagination(prev => ({ ...prev, current: page })),
        }}
      />
      <Modal
        title={editingLog ? '编辑日志' : '添加日志'}
        open={modalVisible}
        onOk={handleSubmit}
        onCancel={() => setModalVisible(false)}
        width={600}
      >
        <Form form={form} layout="vertical">
          <Form.Item label="时间" name="time" rules={[{ required: true }]}>
            <Input type="datetime-local" />
          </Form.Item>
          <Form.Item label="控制员" name="controller" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label="呼号" name="callsign" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label="报告" name="report">
            <TextArea rows={2} />
          </Form.Item>
          <Form.Item label="位置" name="qth">
            <Input />
          </Form.Item>
          <Form.Item label="设备" name="device">
            <Input />
          </Form.Item>
          <Form.Item label="功率" name="power">
            <Input />
          </Form.Item>
          <Form.Item label="天线" name="antenna">
            <Input />
          </Form.Item>
          <Form.Item label="高度" name="height">
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

export default Logs;
