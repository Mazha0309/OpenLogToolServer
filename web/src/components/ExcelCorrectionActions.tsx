import {
  CheckCircleOutlined,
  FileExcelOutlined,
  SafetyCertificateOutlined,
  UploadOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import {
  Alert,
  App,
  Button,
  Descriptions,
  Modal,
  Progress,
  Space,
  Table,
  Tag,
  Typography,
  Upload,
} from 'antd';
import { useState } from 'react';
import { ApiError, sessionsApi } from '../api';
import type {
  ExcelCorrectionCapabilities,
  ExcelCorrectionField,
  ExcelCorrectionPreview,
  ExcelCorrectionProposal,
  SessionSummary,
} from '../types';
import { useI18n } from '../useI18n';
import { parseXlsxFile } from '../utils/sessionExcelImport';

interface ExcelCorrectionActionsProps {
  session: Pick<SessionSummary, 'sessionId' | 'status' | 'role' | 'deletedAt'>;
  administrator?: boolean;
  onApplied: () => void;
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) return `${error.message} (${error.code})`;
  return error instanceof Error ? error.message : String(error);
}

export function ExcelCorrectionActions({
  session,
  administrator = false,
  onApplied,
}: ExcelCorrectionActionsProps) {
  const { t } = useI18n();
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [capabilities, setCapabilities] = useState<ExcelCorrectionCapabilities | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ExcelCorrectionPreview | null>(null);
  const [selected, setSelected] = useState<React.Key[]>([]);
  const [loadingCapabilities, setLoadingCapabilities] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canOpen = !session.deletedAt && (administrator
    ? session.status === 'active' || session.status === 'closed'
    : session.role !== 'viewer' && (
        session.status === 'active' || (session.status === 'closed' && session.role === 'owner')
      ));

  const reset = () => {
    setFile(null);
    setPreview(null);
    setSelected([]);
    setError(null);
  };

  const show = async () => {
    setOpen(true);
    reset();
    setLoadingCapabilities(true);
    try {
      setCapabilities(await sessionsApi.excelCorrectionCapabilities(session.sessionId));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoadingCapabilities(false);
    }
  };

  const generate = async () => {
    if (!file || generating) return;
    setGenerating(true);
    setError(null);
    try {
      const workbook = await parseXlsxFile(file);
      const result = await sessionsApi.previewExcelCorrections(session.sessionId, workbook);
      setPreview(result);
      setSelected(result.proposals
        .filter((proposal) => !proposal.requiresCarefulReview)
        .map((proposal) => proposal.proposalId));
      if (result.proposals.length === 0) message.info(t('excelCorrection.noChanges'));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setGenerating(false);
    }
  };

  const apply = async () => {
    if (!preview?.previewId || selected.length === 0 || applying) return;
    setApplying(true);
    setError(null);
    try {
      const result = await sessionsApi.applyExcelCorrections(
        session.sessionId,
        preview.previewId,
        selected.map(String),
      );
      message.success(t('excelCorrection.applied', { count: result.appliedCount }));
      setOpen(false);
      reset();
      onApplied();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setApplying(false);
    }
  };

  const fieldLabels: Record<ExcelCorrectionField, string> = {
    time: t('common.time'),
    controller: t('logs.controller'),
    callsign: t('logs.callsign'),
    rstSent: t('logs.rstSent'),
    rstRcvd: t('logs.rstRcvd'),
    qth: t('logs.qth'),
    device: t('logs.device'),
    power: t('logs.power'),
    antenna: t('logs.antenna'),
    height: t('logs.height'),
    remarks: t('logs.remarks'),
  };
  const value = (text: string | null) => text === null || text === ''
    ? <Typography.Text type="secondary">{t('excelCorrection.emptyValue')}</Typography.Text>
    : <Typography.Text code>{text}</Typography.Text>;
  const columns = [
    {
      title: t('excelCorrection.target'),
      width: 150,
      render: (_: unknown, proposal: ExcelCorrectionProposal) => (
        <div>
          <Typography.Text strong>#{proposal.ordinal} {proposal.target.callsign}</Typography.Text>
          <br />
          <Typography.Text type="secondary">v{proposal.target.version}</Typography.Text>
        </div>
      ),
    },
    {
      title: t('excelCorrection.source'),
      width: 150,
      render: (_: unknown, proposal: ExcelCorrectionProposal) => (
        <span>{proposal.source.sheet}!{proposal.source.row}</span>
      ),
    },
    {
      title: t('excelCorrection.confidence'),
      width: 125,
      render: (_: unknown, proposal: ExcelCorrectionProposal) => (
        <Space direction="vertical" size={2}>
          <Progress
            percent={Math.round(proposal.confidence * 100)}
            size="small"
            showInfo={false}
            status={proposal.requiresCarefulReview ? 'exception' : 'success'}
          />
          <span>{Math.round(proposal.confidence * 100)}%</span>
          {proposal.requiresCarefulReview && <Tag icon={<WarningOutlined />} color="warning">
            {t('excelCorrection.reviewCarefully')}
          </Tag>}
        </Space>
      ),
    },
    {
      title: t('excelCorrection.changes'),
      render: (_: unknown, proposal: ExcelCorrectionProposal) => (
        <div className="excel-correction-changes">
          {proposal.changes.map((change) => (
            <div key={change.field} className="excel-correction-change">
              <Typography.Text strong>{fieldLabels[change.field]}</Typography.Text>
              <span>{value(change.before)} <span aria-hidden>→</span> {value(change.after)}</span>
            </div>
          ))}
        </div>
      ),
    },
  ];

  return (
    <>
      {canOpen && <Button icon={<FileExcelOutlined />} onClick={() => void show()}>
        {t('excelCorrection.action')}
      </Button>}
      <Modal
        open={open}
        width={1120}
        title={<Space><FileExcelOutlined />{t('excelCorrection.title')}</Space>}
        onCancel={() => setOpen(false)}
        destroyOnHidden
        footer={preview ? <Space>
          <Button onClick={() => { setPreview(null); setSelected([]); setError(null); }}>
            {t('excelCorrection.chooseAnother')}
          </Button>
          <Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
          <Button
            type="primary"
            icon={<CheckCircleOutlined />}
            loading={applying}
            disabled={!preview.previewId || selected.length === 0}
            onClick={() => void apply()}
          >
            {t('excelCorrection.applySelected', { count: selected.length })}
          </Button>
        </Space> : null}
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Alert
            showIcon
            icon={<SafetyCertificateOutlined />}
            type="info"
            message={t('excelCorrection.safetyTitle')}
            description={t('excelCorrection.safetyHint')}
          />
          {session.status === 'closed' && <Alert
            showIcon
            type="warning"
            message={t('excelCorrection.closedSessionHint')}
          />}
          {error && <Alert showIcon closable type="error" message={error} onClose={() => setError(null)} />}
          {!preview && <>
            {loadingCapabilities ? <div className="excel-correction-loading">{t('common.loading')}</div> : capabilities && !capabilities.configured ? <Alert
              showIcon
              type="warning"
              message={t('excelCorrection.notConfigured')}
              description={t('excelCorrection.notConfiguredHint')}
            /> : capabilities && !capabilities.canPreview ? <Alert
              showIcon
              type="warning"
              message={t('excelCorrection.notAllowed')}
            /> : <>
              <Upload.Dragger
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                maxCount={1}
                fileList={file ? [{ uid: 'selected', name: file.name, status: 'done' }] : []}
                beforeUpload={(nextFile) => {
                  setFile(nextFile);
                  setError(null);
                  return false;
                }}
                onRemove={() => { setFile(null); return true; }}
              >
                <p className="ant-upload-drag-icon"><UploadOutlined /></p>
                <p className="ant-upload-text">{t('excelCorrection.dropFile')}</p>
                <p className="ant-upload-hint">{t('excelCorrection.fileHint', {
                  count: capabilities?.maxWorkbookRows ?? 1000,
                })}</p>
              </Upload.Dragger>
              <Button
                block
                type="primary"
                icon={<FileExcelOutlined />}
                loading={generating}
                disabled={!file || !capabilities?.configured}
                onClick={() => void generate()}
              >
                {generating ? t('excelCorrection.generating') : t('excelCorrection.generate')}
              </Button>
            </>}
          </>}
          {preview && <>
            <Descriptions bordered size="small" column={{ xs: 2, sm: 3, md: 6 }} items={[
              { key: 'rows', label: t('excelCorrection.workbookRows'), children: preview.summary.workbookRows },
              { key: 'recognized', label: t('excelCorrection.recognized'), children: preview.summary.extractedRecords },
              { key: 'matched', label: t('excelCorrection.matched'), children: preview.summary.matchedRecords },
              { key: 'unchanged', label: t('excelCorrection.unchanged'), children: preview.summary.unchangedRecords },
              { key: 'skipped', label: t('excelCorrection.skipped'), children: preview.summary.unmatchedRecords + preview.summary.ambiguousRecords },
              { key: 'changes', label: t('excelCorrection.proposed'), children: preview.summary.proposals },
            ]} />
            <Alert
              showIcon
              type="warning"
              message={t('excelCorrection.confirmHint')}
              description={t('excelCorrection.confirmDescription')}
            />
            {preview.summary.warnings.length > 0 && <Alert
              showIcon
              type="info"
              message={t('excelCorrection.skippedRows', { count: preview.summary.warnings.length })}
              description={<div className="excel-correction-warnings">
                {preview.summary.warnings.slice(0, 20).map((warning) => (
                  <div key={`${warning.sheet}-${warning.row}`}>{warning.sheet}!{warning.row}: {warning.message}</div>
                ))}
              </div>}
            />}
            <Table<ExcelCorrectionProposal>
              rowKey="proposalId"
              size="small"
              dataSource={preview.proposals}
              columns={columns}
              pagination={{ pageSize: 25, showSizeChanger: false }}
              scroll={{ x: 980, y: 460 }}
              rowSelection={{
                selectedRowKeys: selected,
                preserveSelectedRowKeys: true,
                onChange: setSelected,
              }}
              expandable={{
                rowExpandable: (proposal) => proposal.notes.length > 0,
                expandedRowRender: (proposal) => (
                  <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
                    {proposal.notes.join('；')}
                  </Typography.Paragraph>
                ),
              }}
            />
          </>}
        </Space>
      </Modal>
    </>
  );
}
