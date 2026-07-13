import { Button, Result } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../useI18n';

export default function NotFoundPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  return <Result status="404" title="404" subTitle={t('error.NOT_FOUND')} extra={<Button type="primary" onClick={() => navigate('/app')}>{t('nav.overview')}</Button>} />;
}
