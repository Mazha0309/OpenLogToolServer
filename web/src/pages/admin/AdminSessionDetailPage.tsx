import {
  ArrowLeftOutlined,
  BarChartOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
  StopOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Drawer,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Tooltip,
  message,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { adminApi, type AdminMember, type AdminSessionDetails, type LogPatch } from '../../api';
import { AsyncContent } from '../../components/AsyncContent';
import { PageHeader } from '../../components/PageHeader';
import { SessionRoleTag, SessionStatusTag } from '../../components/SessionBadges';
import { useAsync } from '../../hooks/useAsync';
import { useI18n } from '../../useI18n';
import {
  adminDangerActionRecovery,
  adminActionErrorMessage,
  shouldReloadAfterAdminActionError,
} from '../../utils/adminActionError';
import type { Invite, LogRecord, PublicShare } from '../../types';

type DangerAction = {
  title: string;
  run: (reason: string) => Promise<unknown>;
  onConflict?: () => void;
};

function AdminLogs({ sessionId, accessId, sessionDeleted, danger }: { sessionId: string; accessId: string; sessionDeleted: boolean; danger: (action: DangerAction) => void }) {
  const { t, locale } = useI18n();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [query, setQuery] = useState('');
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [editing, setEditing] = useState<LogRecord | null>(null);
  const [creating, setCreating] = useState(false);
  const [form] = Form.useForm<LogPatch>();
  const [messageApi, contextHolder] = message.useMessage();
  const state = useAsync(() => adminApi.sessionLogs(sessionId, accessId, { page, pageSize, q: query || undefined, includeDeleted }), [sessionId, accessId, page, pageSize, query, includeDeleted]);
  useEffect(() => { if (editing) form.setFieldsValue(editing); }, [editing, form]);
  useEffect(() => {
    if (sessionDeleted) {
      setEditing(null);
      setCreating(false);
    }
  }, [sessionDeleted]);
  const save = async () => {
    if (sessionDeleted || (!editing && !creating)) return;
    const value = await form.validateFields();
    const optional = (text: string | null | undefined) => text?.trim() ? text.trim() : null;
    const patch: LogPatch = {
      time: value.time, callsign: value.callsign.trim().toUpperCase(), controller: value.controller.trim().toUpperCase(),
      rstSent: optional(value.rstSent), rstRcvd: optional(value.rstRcvd), qth: optional(value.qth),
      device: optional(value.device), power: optional(value.power), antenna: optional(value.antenna),
      height: optional(value.height), remarks: optional(value.remarks),
    };
    if (creating) {
      danger({ title: t('common.create'), onConflict: state.reload, run: async (reason) => { await adminApi.createLog(sessionId, patch, reason); setCreating(false); state.reload(); } });
      return;
    }
    await adminApi.updateLog(sessionId, editing!, patch);
    messageApi.success(t('logs.saved')); setEditing(null); state.reload();
  };
  return <>{contextHolder}{sessionDeleted && <Alert showIcon type="info" message={t('admin.deletedSessionReadonly')} style={{ marginBottom: 16 }} />}<Card className="surface table-card" title={<Space className="table-toolbar" wrap><Input.Search className="table-toolbar-search" allowClear placeholder={t('common.search')} onSearch={(value) => { setPage(1); setQuery(value.trim()); }} /><Checkbox checked={includeDeleted} onChange={(event) => { setPage(1); setIncludeDeleted(event.target.checked); }}>{t('logs.includeDeleted')}</Checkbox>{!sessionDeleted && <Button type="primary" icon={<PlusOutlined />} onClick={() => { setCreating(true); form.resetFields(); form.setFieldsValue({ time: new Date().toISOString(), controller: '', callsign: '', rstSent: null, rstRcvd: null, qth: null, device: null, power: null, antenna: null, height: null, remarks: null }); }}>{t('common.create')}</Button>}</Space>} extra={<Button type="text" icon={<ReloadOutlined />} onClick={state.reload}>{t('common.refresh')}</Button>}>
    <AsyncContent loading={state.loading} error={state.error} empty={!state.loading && !state.data?.items.length} onRetry={state.reload}>
      <Table<LogRecord> rowKey="syncId" dataSource={state.data?.items ?? []} size="middle" scroll={{ x: 1320 }} pagination={{ current: page, pageSize, total: state.data?.total, showSizeChanger: true, onChange: (next, size) => { setPage(next); setPageSize(size); } }} columns={[
        { title: t('common.time'), dataIndex: 'time', fixed: 'left', width: 180, render: (value: string) => new Date(value).toLocaleString(locale) },
        { title: t('logs.callsign'), dataIndex: 'callsign', fixed: 'left', width: 115, render: (value: string, row) => <Space><strong>{value}</strong>{row.deletedAt && <Tag color="red">{t('session.deleted')}</Tag>}</Space> },
        { title: t('logs.controller'), dataIndex: 'controller', width: 110 },
        { title: t('logs.rstSent'), dataIndex: 'rstSent', width: 90, render: (value: string | null) => value ?? '—' },
        { title: t('logs.rstRcvd'), dataIndex: 'rstRcvd', width: 90, render: (value: string | null) => value ?? '—' },
        { title: t('logs.qth'), dataIndex: 'qth', width: 150, ellipsis: true },
        { title: t('logs.device'), dataIndex: 'device', width: 140, ellipsis: true },
        { title: t('logs.power'), dataIndex: 'power', width: 90 },
        { title: t('logs.antenna'), dataIndex: 'antenna', width: 140, ellipsis: true },
        { title: t('logs.remarks'), dataIndex: 'remarks', width: 200, ellipsis: true },
        { title: t('common.actions'), fixed: 'right', width: 180, render: (_: unknown, row) => sessionDeleted ? '—' : row.deletedAt
          ? <Button type="link" icon={<UndoOutlined />} onClick={() => danger({ title: t('common.restore'), onConflict: state.reload, run: async (reason) => { await adminApi.restoreLog(sessionId, row, reason); state.reload(); } })}>{t('common.restore')}</Button>
          : <Space size={0}><Button type="link" icon={<EditOutlined />} onClick={() => setEditing(row)}>{t('common.edit')}</Button><Button danger type="link" icon={<DeleteOutlined />} onClick={() => danger({ title: t('common.delete'), onConflict: state.reload, run: async (reason) => { await adminApi.deleteLog(sessionId, row, reason); state.reload(); } })}>{t('common.delete')}</Button></Space> },
      ]} />
    </AsyncContent>
  </Card>
  <Drawer width={520} title={creating ? t('common.create') : t('logs.editTitle')} open={Boolean(editing) || creating} onClose={() => { setEditing(null); setCreating(false); }} extra={<Space><Button onClick={() => { setEditing(null); setCreating(false); }}>{t('common.cancel')}</Button><Button type="primary" icon={<SaveOutlined />} onClick={() => void save()}>{t('common.save')}</Button></Space>}>
    <Form form={form} layout="vertical"><Form.Item name="time" label={t('common.time')} rules={[{ required: true }]}><Input /></Form.Item><div className="content-grid"><Form.Item name="callsign" label={t('logs.callsign')} rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="controller" label={t('logs.controller')} rules={[{ required: true }]}><Input /></Form.Item></div><div className="content-grid"><Form.Item name="rstSent" label={t('logs.rstSent')}><Input /></Form.Item><Form.Item name="rstRcvd" label={t('logs.rstRcvd')}><Input /></Form.Item></div><Form.Item name="qth" label={t('logs.qth')}><Input /></Form.Item><div className="content-grid"><Form.Item name="device" label={t('logs.device')}><Input /></Form.Item><Form.Item name="power" label={t('logs.power')}><Input /></Form.Item></div><div className="content-grid"><Form.Item name="antenna" label={t('logs.antenna')}><Input /></Form.Item><Form.Item name="height" label={t('logs.height')}><Input /></Form.Item></div><Form.Item name="remarks" label={t('logs.remarks')}><Input.TextArea rows={5} /></Form.Item></Form>
  </Drawer></>;
}

function AdminMembers({ sessionId, accessId, sessionDeleted, onChanged, danger }: { sessionId: string; accessId: string; sessionDeleted: boolean; onChanged: () => void; danger: (action: DangerAction) => void }) {
  const { t, locale } = useI18n();
  const state = useAsync(() => adminApi.sessionMembers(sessionId, accessId), [sessionId, accessId]);
  const [addOpen, setAddOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [addForm] = Form.useForm<{ userId: string; role: 'editor' | 'viewer' }>();
  const [transferForm] = Form.useForm<{ targetUserId: string }>();
  const transferTargets = (state.data?.items ?? []).filter((member) => member.role !== 'owner' && !member.removedAt && !member.accountDisabledAt && !member.accountDeletedAt);
  const stageAdd = async () => {
    if (sessionDeleted) return;
    const values = await addForm.validateFields();
    setAddOpen(false);
    danger({ title: t('admin.addMember'), onConflict: state.reload, run: async (reason) => { await adminApi.addAdminMember(sessionId, values.userId.trim(), values.role, reason); addForm.resetFields(); state.reload(); onChanged(); } });
  };
  const stageTransfer = async () => {
    if (sessionDeleted) return;
    const values = await transferForm.validateFields();
    setTransferOpen(false);
    danger({ title: t('admin.transferOwnership'), onConflict: state.reload, run: async (reason) => { await adminApi.transferOwnership(sessionId, values.targetUserId, reason); transferForm.resetFields(); state.reload(); onChanged(); } });
  };
  return <>{sessionDeleted && <Alert showIcon type="info" message={t('admin.deletedMembersReadonly')} style={{ marginBottom: 16 }} />}<Card className="surface table-card" title={!sessionDeleted && <Space wrap><Button type="primary" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>{t('admin.addMember')}</Button><Button disabled={!transferTargets.length} onClick={() => setTransferOpen(true)}>{t('admin.transferOwnership')}</Button></Space>}><AsyncContent loading={state.loading} error={state.error} empty={!state.loading && !state.data?.items.length} onRetry={state.reload}>
    <Table<AdminMember> rowKey="membershipId" dataSource={state.data?.items ?? []} pagination={false} scroll={{ x: 800 }} columns={[
      { title: t('members.user'), dataIndex: 'username', render: (value: string, row) => <div><strong>{value}</strong><br /><span className="error-code">{row.userId}</span></div> },
      { title: t('common.role'), dataIndex: 'role', width: 170, render: (value: AdminMember['role'], row) => value === 'owner' ? <SessionRoleTag role="owner" /> : <Select disabled={sessionDeleted || Boolean(row.removedAt)} value={value} style={{ width: 130 }} options={[{ value: 'editor', label: t('role.editor') }, { value: 'viewer', label: t('role.viewer') }]} onChange={(role) => danger({ title: t('admin.changeRole'), onConflict: state.reload, run: async (reason) => { await adminApi.updateAdminMember(sessionId, row, role, reason); state.reload(); onChanged(); } })} /> },
      { title: t('members.joinedAt'), dataIndex: 'joinedAt', width: 190, render: (value: string) => new Date(value).toLocaleString(locale) },
      { title: t('common.status'), width: 130, render: (_, row) => row.removedAt ? <Tag color="red">{t('common.close')}</Tag> : <Tag color="green">{t('common.active')}</Tag> },
      { title: t('common.actions'), width: 120, render: (_, row) => sessionDeleted || row.role === 'owner' || row.removedAt ? null : <Button danger type="link" icon={<DeleteOutlined />} onClick={() => danger({ title: t('common.delete'), onConflict: state.reload, run: async (reason) => { await adminApi.removeAdminMember(sessionId, row, reason); state.reload(); onChanged(); } })}>{t('common.delete')}</Button> },
    ]} />
  </AsyncContent></Card>
  <Modal open={addOpen} title={t('admin.addMember')} okText={t('common.save')} cancelText={t('common.cancel')} onOk={() => void stageAdd()} onCancel={() => setAddOpen(false)} destroyOnHidden><Form form={addForm} layout="vertical" initialValues={{ role: 'editor' }}><Form.Item name="userId" label={t('admin.userId')} rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="role" label={t('common.role')} rules={[{ required: true }]}><Select options={[{ value: 'editor', label: t('role.editor') }, { value: 'viewer', label: t('role.viewer') }]} /></Form.Item></Form></Modal>
  <Modal open={transferOpen} title={t('admin.transferOwnership')} okText={t('common.save')} cancelText={t('common.cancel')} onOk={() => void stageTransfer()} onCancel={() => setTransferOpen(false)} destroyOnHidden><Alert showIcon type="warning" message={t('admin.transferOwnershipHint')} style={{ marginBottom: 16 }} /><Form form={transferForm} layout="vertical"><Form.Item name="targetUserId" label={t('members.user')} rules={[{ required: true }]}><Select showSearch optionFilterProp="label" options={transferTargets.map((member) => ({ value: member.userId, label: `${member.username} (${member.userId})` }))} /></Form.Item></Form></Modal></>;
}

function AdminLinks({ sessionId, accessId, danger }: { sessionId: string; accessId: string; danger: (action: DangerAction) => void }) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const invites = useAsync(() => adminApi.adminInvites(sessionId, accessId), [sessionId, accessId]);
  const shares = useAsync(() => adminApi.adminShares(sessionId, accessId), [sessionId, accessId]);
  return <div className="content-grid">
    <Card className="surface table-card" title={t('sessions.invites')}><AsyncContent loading={invites.loading} error={invites.error} empty={!invites.loading && !invites.data?.items.length} onRetry={invites.reload}><Table<Invite> rowKey="inviteId" dataSource={invites.data?.items ?? []} pagination={false} size="small" scroll={{ x: 600 }} columns={[
      { title: t('invites.codeHint'), dataIndex: 'codeHint' }, { title: t('common.role'), dataIndex: 'role' },
      { title: t('invites.expires'), dataIndex: 'expiresAt', render: (value: string) => new Date(value).toLocaleString(locale) },
      { title: t('common.actions'), render: (_, row) => row.revokedAt ? null : <Button danger type="link" onClick={() => danger({ title: t('common.revoke'), onConflict: invites.reload, run: async (reason) => { await adminApi.revokeAdminInvite(sessionId, row.inviteId, reason); invites.reload(); } })}>{t('common.revoke')}</Button> },
    ]} /></AsyncContent></Card>
    <Card className="surface table-card" title={t('sessions.shares')}><AsyncContent loading={shares.loading} error={shares.error} empty={!shares.loading && !shares.data?.items.length} onRetry={shares.reload}><Table<PublicShare> rowKey="publicShareId" dataSource={shares.data?.items ?? []} pagination={false} size="small" scroll={{ x: 600 }} columns={[
      { title: 'ID', dataIndex: 'publicShareId', ellipsis: true }, { title: t('invites.expires'), dataIndex: 'expiresAt', render: (value: string) => new Date(value).toLocaleString(locale) },
      { title: t('common.actions'), render: (_, row) => <Space size={0}>
        <Button type="link" icon={<BarChartOutlined />} onClick={() => navigate(`/admin/operations/liveshares/${encodeURIComponent(row.publicShareId)}`)}>{t('common.details')}</Button>
        {!row.revokedAt && <Button danger type="link" onClick={() => danger({ title: t('common.revoke'), onConflict: shares.reload, run: async (reason) => { await adminApi.revokeAdminShare(sessionId, row.publicShareId, reason); shares.reload(); } })}>{t('common.revoke')}</Button>}
      </Space> },
    ]} /></AsyncContent></Card>
  </div>;
}

function Governance({ details, reload, danger }: { details: AdminSessionDetails; reload: () => void; danger: (action: DangerAction) => void }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [messageApi, contextHolder] = message.useMessage();
  const [recoverOpen, setRecoverOpen] = useState(false);
  const [commandWorking, setCommandWorking] = useState<'close' | 'reopen' | null>(null);
  const [recoverForm] = Form.useForm<{ title: string; ownerUserId: string }>();
  const session = details.session;
  const liveDraftBlocksClose = details.liveDraft.hasActualContent ||
    details.liveDraft.activeLockCount > 0;
  const runCommand = async (command: 'close' | 'reopen') => {
    if (commandWorking) return;
    setCommandWorking(command);
    try {
      await adminApi.sessionCommand(session.sessionId, command, session.version);
      messageApi.success(t('settings.applied'));
      reload();
    } catch (error) {
      messageApi.error(adminActionErrorMessage(error, t('error.default')));
      if (shouldReloadAfterAdminActionError(error)) reload();
    } finally {
      setCommandWorking(null);
    }
  };
  const stageRecovery = async () => {
    const values = await recoverForm.validateFields();
    setRecoverOpen(false);
    danger({ title: t('admin.recoverSession'), onConflict: reload, run: async (reason) => {
      const recovered = await adminApi.recoverSession(session.sessionId, {
        title: values.title.trim(),
        ownerUserId: values.ownerUserId.trim(),
        reason,
      });
      recoverForm.resetFields();
      navigate(`/admin/sessions/${encodeURIComponent(recovered.recoveredSessionId)}`);
    } });
  };
  return <>{contextHolder}<div className="content-grid">
    <Card className="surface" title={t('sessions.settings')}><Form layout="vertical" initialValues={{ title: session.title }} onFinish={async ({ title }: { title: string }) => { await adminApi.updateSession(session.sessionId, session.version, title.trim()); messageApi.success(t('settings.applied')); reload(); }}><Form.Item name="title" label={t('settings.sessionTitle')} rules={[{ required: true }, { max: 200 }]}><Input disabled={Boolean(session.deletedAt)} /></Form.Item>{!session.deletedAt && <Button type="primary" htmlType="submit" icon={<SaveOutlined />}>{t('common.save')}</Button>}</Form></Card>
    <Card className="surface" title={t('common.actions')}><Alert showIcon type="warning" message={t('admin.dangerActionsHint')} style={{ marginBottom: 16 }} />
      {!session.deletedAt && session.status === 'active' && liveDraftBlocksClose && <Alert showIcon type="error" message={t('admin.forceCloseSessionHint')} style={{ marginBottom: 16 }} />}
      <Space wrap>
      {!session.deletedAt && session.status === 'active' && <Button loading={commandWorking === 'close'} disabled={commandWorking !== null} icon={<StopOutlined />} onClick={() => void runCommand('close')}>{t('admin.closeSession')}</Button>}
      {!session.deletedAt && session.status === 'active' && liveDraftBlocksClose && <Button danger icon={<StopOutlined />} onClick={() => danger({ title: t('admin.forceCloseSession'), onConflict: reload, run: async (reason) => { await adminApi.closeDiscardingLiveDraft(session.sessionId, session.version, reason); reload(); } })}>{t('admin.forceCloseSession')}</Button>}
      {!session.deletedAt && session.status === 'closed' && <Button loading={commandWorking === 'reopen'} disabled={commandWorking !== null} onClick={() => void runCommand('reopen')}>{t('admin.reopenSession')}</Button>}
      {!session.deletedAt && session.status === 'active' && <Tooltip title={t('admin.deleteRequiresClosed')}><span><Button disabled danger icon={<DeleteOutlined />}>{t('common.delete')}</Button></span></Tooltip>}
      {!session.deletedAt && session.status !== 'active' && <Button danger icon={<DeleteOutlined />} onClick={() => danger({ title: t('common.delete'), onConflict: reload, run: async (reason) => { await adminApi.deleteSession(session.sessionId, session.version, reason); reload(); } })}>{t('common.delete')}</Button>}
      {session.deletedAt && <Button type="primary" icon={<UndoOutlined />} onClick={() => { recoverForm.setFieldsValue({ title: `${session.title}${t('admin.recoveredTitleSuffix')}`, ownerUserId: session.ownerUserId }); setRecoverOpen(true); }}>{t('admin.recoverSession')}</Button>}
      <Button onClick={() => danger({ title: t('admin.exportCsv'), run: (reason) => adminApi.exportSession(session.sessionId, 'csv', false, reason) })}>{t('admin.exportCsv')}</Button>
      <Button onClick={() => danger({ title: t('admin.exportJson'), run: (reason) => adminApi.exportSession(session.sessionId, 'json', true, reason) })}>{t('admin.exportJson')}</Button>
    </Space></Card>
  </div><Modal open={recoverOpen} title={t('admin.recoverSession')} okText={t('common.save')} cancelText={t('common.cancel')} onOk={() => void stageRecovery()} onCancel={() => setRecoverOpen(false)} destroyOnHidden><Alert showIcon type="warning" message={t('admin.recoveryOwnerHint')} style={{ marginBottom: 16 }} /><Form form={recoverForm} layout="vertical"><Form.Item name="title" label={t('settings.sessionTitle')} rules={[{ required: true }, { max: 200 }]}><Input /></Form.Item><Form.Item name="ownerUserId" label={t('admin.userId')} rules={[{ required: true }]}><Input /></Form.Item></Form></Modal></>;
}

export default function AdminSessionDetailPage() {
  const { sessionId = '' } = useParams();
  // Pagination and child tabs share this ID; navigating to another resource starts a new visit.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  const accessId = useMemo(() => crypto.randomUUID(), [sessionId]);
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const state = useAsync(() => adminApi.session(sessionId, accessId), [sessionId, accessId]);
  const [dangerAction, setDangerAction] = useState<DangerAction | null>(null);
  const [dangerForm] = Form.useForm();
  const [working, setWorking] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const executeDanger = async () => {
    if (!dangerAction || working) return;
    const { password, reason } = await dangerForm.validateFields();
    setWorking(true);
    try {
      await adminApi.elevate(password);
      await dangerAction.run(reason.trim());
      messageApi.success(t('settings.applied'));
      setDangerAction(null);
      dangerForm.resetFields();
    } catch (error) {
      messageApi.error(adminActionErrorMessage(error, t('error.default')));
      if (adminDangerActionRecovery(error) === 'dismiss-and-reload') {
        setDangerAction(null);
        dangerForm.resetFields();
        dangerAction.onConflict?.();
        state.reload();
      }
    }
    finally { setWorking(false); }
  };
  const details = state.data;
  const session = details?.session;
  const tabs = details ? [
    { key: 'overview', label: t('nav.overview'), children: <><div className="stat-grid"><Card className="surface"><Statistic title={t('sessions.logs')} value={details.counts.logs} /></Card><Card className="surface"><Statistic title={t('admin.deletedLogs')} value={details.counts.deleted_logs} /></Card><Card className="surface"><Statistic title={t('sessions.members')} value={details.counts.members} /></Card><Card className="surface"><Statistic title={t('admin.liveDraft')} value={details.liveDraft.activeLockCount} /></Card></div><Card className="surface"><Descriptions bordered size="small" column={{ xs: 1, sm: 2 }} items={[{ key: 'owner', label: t('admin.owner'), children: details.session.ownerUsername }, { key: 'version', label: 'Version', children: details.session.version }, { key: 'seq', label: 'High-watermark', children: details.session.highWatermarkSeq }, { key: 'updated', label: t('sessions.updatedAt'), children: new Date(details.session.updatedAt).toLocaleString(locale) }]} /></Card></> },
    { key: 'logs', label: t('sessions.logs'), children: <AdminLogs sessionId={sessionId} accessId={accessId} sessionDeleted={Boolean(session?.deletedAt)} danger={setDangerAction} /> },
    { key: 'members', label: t('sessions.members'), children: <AdminMembers sessionId={sessionId} accessId={accessId} sessionDeleted={Boolean(session?.deletedAt)} onChanged={state.reload} danger={setDangerAction} /> },
    { key: 'links', label: `${t('sessions.invites')} / ${t('sessions.shares')}`, children: <AdminLinks sessionId={sessionId} accessId={accessId} danger={setDangerAction} /> },
    { key: 'settings', label: t('sessions.settings'), children: <Governance details={details} reload={state.reload} danger={setDangerAction} /> },
  ] : [];
  return <>{contextHolder}<PageHeader title={session ? <span className="session-title-row">{session.title}<SessionStatusTag status={session.deletedAt ? 'deleted' : session.status} /></span> : t('sessions.session')} description={session?.sessionId} actions={<Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/admin/sessions')}>{t('sessions.back')}</Button>} />
    <AsyncContent loading={state.loading} error={state.error} onRetry={state.reload}>{details && <Tabs items={tabs} />}</AsyncContent>
    <Modal open={Boolean(dangerAction)} title={dangerAction?.title} okText={t('common.save')} cancelText={t('common.cancel')} confirmLoading={working} onOk={() => void executeDanger()} onCancel={() => { setDangerAction(null); dangerForm.resetFields(); }}><Alert showIcon type="warning" message={t('admin.reauthenticateHint')} style={{ marginBottom: 16 }} /><Form form={dangerForm} layout="vertical"><Form.Item name="password" label={t('auth.password')} rules={[{ required: true }]}><Input.Password autoComplete="current-password" /></Form.Item><Form.Item name="reason" label={t('admin.reason')} rules={[{ required: true }, { min: 3 }, { max: 500 }]}><Input.TextArea rows={3} maxLength={500} showCount /></Form.Item></Form></Modal>
  </>;
}
