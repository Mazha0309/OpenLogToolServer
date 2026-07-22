import { Typography } from 'antd';
import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { adminApi } from '../../api';
import { PersonalSessionDetail } from '../../components/PersonalSessionDetail';
import { useAsync } from '../../hooks/useAsync';

export default function AdminPersonalSessionDetailPage() {
  const { userId = '', sessionId = '' } = useParams();
  // Reuse one audited detail visit ID for metadata and paged logs.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  const accessId = useMemo(() => crypto.randomUUID(), [userId, sessionId]);
  const navigate = useNavigate();
  const state = useAsync(
    () => adminApi.personalSession(userId, sessionId, accessId),
    [userId, sessionId, accessId],
  );
  const detail = state.data?.session.sessionId === sessionId ? state.data : null;
  return <PersonalSessionDetail
    details={detail}
    loading={state.loading}
    error={state.error}
    onReload={state.reload}
    onBack={() => navigate(`/admin/sessions/accounts/${encodeURIComponent(userId)}`)}
    loadLogs={(params) => adminApi.personalSessionLogs(userId, sessionId, accessId, params)}
    onExport={() => adminApi.exportPersonalSnapshotSessionDatabaseV7(userId, sessionId)}
    accountLabel={state.data ? <><Typography.Text strong>{state.data.user.username}</Typography.Text><br /><span className="error-code">{state.data.user.id}</span></> : undefined}
  />;
}
