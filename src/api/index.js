import express from 'express';
import authRoutes from './routes/auth.js';
import logsRoutes from './routes/logs.js';
import dictionariesRoutes from './routes/dictionaries.js';
import adminRoutes from './routes/admin.js';

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/logs', logsRoutes);
router.use('/dictionaries', dictionariesRoutes);
router.use('/admin', adminRoutes);

router.get('/health', (req, res) => {
  res.json({ success: true, data: { status: 'ok', timestamp: new Date().toISOString() } });
});

function errorHandler(err, req, res, next) {
  console.error('API Error:', err);
  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: process.env.NODE_ENV === 'production' ? '服务器内部错误' : err.message,
    },
  });
}

router.use(errorHandler);

export default router;
