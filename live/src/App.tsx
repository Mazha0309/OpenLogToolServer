import { useEffect, useState, useRef } from 'react';
import { Table, Typography, Tag } from 'antd';

interface LogEntry {
  sync_id: string; controller: string; callsign: string; time: string;
  rst_sent?: string; rst_rcvd?: string; qth?: string; device?: string;
  power?: string; antenna?: string; height?: string;
}

const WS_BASE = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;

export default function Live() {
  const sessionId = window.location.pathname.replace('/live/', '');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    const ws = new WebSocket(`${WS_BASE}/ws?sessionId=${sessionId}`);
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'log.upsert') {
        setLogs(prev => {
          const idx = prev.findIndex(l => l.sync_id === msg.log.sync_id);
          if (idx >= 0) { const next = [...prev]; next[idx] = msg.log; return next; }
          return [...prev, msg.log];
        });
      } else if (msg.type === 'log.delete') {
        setLogs(prev => prev.filter(l => l.sync_id !== msg.syncId));
      }
    };
    wsRef.current = ws;
    return () => ws.close();
  }, [sessionId]);

  return (
    <div style={{ padding: 24 }}>
      <Typography.Title level={4} style={{ marginBottom: 16 }}>
        Session: {sessionId} <Tag color="green">LIVE</Tag>
      </Typography.Title>
      <Table dataSource={logs} rowKey="sync_id" columns={[
        { title: '时间', dataIndex: 'time', width: 80, render: (v: string) => v?.substring(0, 5) },
        { title: '主控', dataIndex: 'controller', width: 90 },
        { title: '呼号', dataIndex: 'callsign', width: 90 },
        { title: 'RST发', dataIndex: 'rst_sent', width: 70 },
        { title: 'RST收', dataIndex: 'rst_rcvd', width: 70 },
        { title: '设备', dataIndex: 'device', width: 90 },
        { title: '天线', dataIndex: 'antenna', width: 90 },
        { title: '功率', dataIndex: 'power', width: 60 },
        { title: 'QTH', dataIndex: 'qth', width: 100 },
        { title: '高度', dataIndex: 'height', width: 60 },
      ]} pagination={false} size="small" bordered />
    </div>
  );
}
