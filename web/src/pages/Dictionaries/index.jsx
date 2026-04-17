import { useEffect, useState } from 'react';
import { Table, Button, Modal, Form, Input, Select, message, Space, Tabs } from 'antd';
import { getDictionaries, createDictionary, updateDictionary, deleteDictionary } from '../../services/dictionary';

const { TabPane } = Tabs;
const types = [
  { label: '设备', value: 'device' },
  { label: '天线', value: 'antenna' },
  { label: '位置', value: 'qth' },
  { label: '呼号', value: 'callsign' },
];

function Dictionaries() {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeType, setActiveType] = useState('device');
  const [modalVisible, setModalVisible] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const [form] = Form.useForm();

  useEffect(() => {
    loadDictionaries();
  }, [activeType]);

  const loadDictionaries = async () => {
    setLoading(true);
    try {
      const result = await getDictionaries(activeType);
      if (result.success) {
        setData(result.data);
      }
    } catch (error) {
      message.error('加载失败');
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = () => {
    setEditingItem(null);
    form.resetFields();
    setModalVisible(true);
  };

  const handleEdit = (record) => {
    setEditingItem(record);
    form.setFieldsValue(record);
    setModalVisible(true);
  };

  const handleDelete = async (id) => {
    try {
      const result = await deleteDictionary(id);
      if (result.success) {
        message.success('删除成功');
        loadDictionaries();
      }
    } catch (error) {
      message.error('删除失败');
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      if (editingItem) {
        await updateDictionary(editingItem.id, values);
      } else {
        await createDictionary(activeType, values);
      }
      message.success(editingItem ? '更新成功' : '创建成功');
      setModalVisible(false);
      loadDictionaries();
    } catch (error) {
      message.error('操作失败');
    }
  };

  const columns = [
    { title: '原始值', dataIndex: 'raw', key: 'raw' },
    { title: '拼音', dataIndex: 'pinyin', key: 'pinyin' },
    { title: '缩写', dataIndex: 'abbreviation', key: 'abbreviation' },
    { title: '操作', key: 'action', render: (_, record) => (
      <Space>
        <Button size="small" onClick={() => handleEdit(record)}>编辑</Button>
        <Button size="small" danger onClick={() => handleDelete(record.id)}>删除</Button>
      </Space>
    )},
  ];

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 24, marginBottom: 24 }}>词典管理</h1>
      <Tabs activeKey={activeType} onChange={setActiveType}>
        {types.map(t => (
          <TabPane key={t.value} tab={t.label}>
            <Button type="primary" onClick={handleAdd} style={{ marginBottom: 16 }}>添加</Button>
            <Table
              columns={columns}
              dataSource={data}
              loading={loading}
              rowKey="id"
              pagination={{ pageSize: 50 }}
            />
          </TabPane>
        ))}
      </Tabs>
      <Modal
        title={editingItem ? '编辑词典' : '添加词典'}
        open={modalVisible}
        onOk={handleSubmit}
        onCancel={() => setModalVisible(false)}
      >
        <Form form={form} layout="vertical">
          <Form.Item label="原始值" name="raw" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label="拼音" name="pinyin">
            <Input />
          </Form.Item>
          <Form.Item label="缩写" name="abbreviation">
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

export default Dictionaries;
