import { useNavigate, useParams } from 'react-router-dom';
import { accountApi } from '../../api';
import { PersonalSessionDetail } from '../../components/PersonalSessionDetail';
import { useAsync } from '../../hooks/useAsync';

export default function PersonalSessionDetailPage() {
  const { sessionId = '' } = useParams();
  const navigate = useNavigate();
  const state = useAsync(
    () => accountApi.personalSession(sessionId),
    [sessionId],
  );
  const detail = state.data?.session.sessionId === sessionId ? state.data : null;
  return <PersonalSessionDetail
    details={detail}
    loading={state.loading}
    error={state.error}
    onReload={state.reload}
    onBack={() => navigate('/app/sessions')}
    loadLogs={(params) => accountApi.personalSessionLogs(sessionId, params)}
    onExport={() => accountApi.exportPersonalSnapshotSessionDatabaseV7(sessionId)}
  />;
}
