import { Button, Empty, Result, Skeleton } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { ApiError } from '../api';
import { useI18n } from '../useI18n';

interface Props {
  loading: boolean;
  error: unknown;
  empty?: boolean;
  onRetry: () => void;
  children: React.ReactNode;
}

export function AsyncContent({ loading, error, empty, onRetry, children }: Props) {
  const { t } = useI18n();
  if (loading) return <div className="empty-state"><Skeleton active paragraph={{ rows: 5 }} /></div>;
  if (error) {
    const apiError = error instanceof ApiError ? error : null;
    const key = apiError?.code === 'NETWORK_ERROR' ? 'error.NETWORK_ERROR'
      : apiError?.code === 'FORBIDDEN' ? 'error.FORBIDDEN'
        : apiError?.code === 'NOT_FOUND' ? 'error.NOT_FOUND' : 'error.default';
    return (
      <Result
        status={apiError?.status === 403 ? '403' : apiError?.status === 404 ? '404' : 'error'}
        title={t('common.error')}
        subTitle={<><div>{t(key)}</div>{apiError?.code && <div className="error-code">{apiError.code}</div>}</>}
        extra={<Button icon={<ReloadOutlined />} onClick={onRetry}>{t('common.retry')}</Button>}
      />
    );
  }
  if (empty) return <div className="empty-state"><Empty description={t('common.empty')} /></div>;
  return children;
}
