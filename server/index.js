import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import apiRouter from '../src/api/index.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

app.use(helmet({
  contentSecurityPolicy: false,
}));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/api/v1', apiRouter);

const webDistPath = path.join(__dirname, '..', 'web', 'dist');
app.use(express.static(webDistPath));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'API endpoint not found' } });
  }
  res.sendFile(path.join(webDistPath, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                    OpenLogToolServer                        ║
╠══════════════════════════════════════════════════════════════╣
║  🌐 Web UI:     http://localhost:${PORT}                       ║
║  📡 API:        http://localhost:${PORT}/api/v1               ║
║  📖 API 文档:   http://localhost:${PORT}/api/v1/health       ║
╠══════════════════════════════════════════════════════════════╣
║  👤 管理员账号: admin                                        ║
║  🔑 管理员密码: admin123                                     ║
╚══════════════════════════════════════════════════════════════╝
`);
});
