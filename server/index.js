import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import apiRouter from '../src/api/index.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/api/v1', apiRouter);

app.get('/', (req, res) => {
  res.json({
    success: true,
    data: {
      name: 'OpenLogToolServer',
      version: '0.1.0',
      status: 'running',
      docs: '/api/v1/health',
    },
  });
});

app.listen(PORT, HOST, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                    OpenLogToolServer                        ║
╠══════════════════════════════════════════════════════════════╣
║  🌐 Web UI:     http://localhost:3001                        ║
║  📡 API:        http://localhost:${PORT}/api/v1               ║
║  📖 API 文档:   http://localhost:${PORT}/api/v1/health       ║
╠══════════════════════════════════════════════════════════════╣
║  👤 管理员账号: admin                                        ║
║  🔑 管理员密码: admin123                                     ║
╚══════════════════════════════════════════════════════════════╝
`);
});
