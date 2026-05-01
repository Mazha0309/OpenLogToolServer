import express from 'express';
import { DictionaryService } from '../../services/index.js';
import { authMiddleware } from './logs.js';

const router = express.Router();
const dictionaryService = new DictionaryService();
await dictionaryService.init();

router.get('/', authMiddleware, async (req, res) => {
  try {
    let { type, search } = req.query;
    if (typeof type === 'object' && type !== null) type = type.type || '';
    const dictionaries = await dictionaryService.listDictionaries(type, { search }, req.user.id);
    res.json({ success: true, data: dictionaries });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.get('/:type', authMiddleware, async (req, res) => {
  try {
    const { type } = req.params;
    const { search } = req.query;
    const dictionaries = await dictionaryService.listDictionaries(type, { search }, req.user.id);
    res.json({ success: true, data: dictionaries });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.post('/', authMiddleware, async (req, res) => {
  try {
    const { type, raw, pinyin, abbreviation } = req.body;
    if (!type || !raw) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_PARAMS', message: '缺少 type 或 raw' } });
    }
    const dictionary = await dictionaryService.createDictionary(type, { raw, pinyin, abbreviation }, req.user.id);
    res.json({ success: true, data: dictionary });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { raw, pinyin, abbreviation } = req.body;
    const dictionary = await dictionaryService.updateDictionary(id, { raw, pinyin, abbreviation }, req.user.id);
    if (!dictionary) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '词典条目不存在' } });
    }
    res.json({ success: true, data: dictionary });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await dictionaryService.deleteDictionary(id, req.user.id);
    if (!deleted) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '词典条目不存在' } });
    }
    res.json({ success: true, data: { deleted: true } });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.post('/bulk', authMiddleware, async (req, res) => {
  try {
    const { type, items } = req.body;
    if (!type || !items || !Array.isArray(items)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_PARAMS', message: '缺少 type 或 items' } });
    }
    const dictionaries = await dictionaryService.bulkCreate(type, items);
    res.json({ success: true, data: dictionaries });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

export default router;
