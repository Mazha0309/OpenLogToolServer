/**
 * Reset a user password directly in SQLite.
 *
 * Usage: node tools/reset-password.js [username] [new-password]
 *   With no args: lists all users then exits
 *   Default password: admin123
 */
import Database from 'better-sqlite3';
import path from 'path';

const db = new Database(path.join(process.cwd(), 'data', 'openlogtool.db'));

const users = db.prepare('SELECT id, username, role FROM users').all();
if (users.length === 0) {
  console.error('数据库中没有任何用户');
  process.exit(1);
}

const targetUsername = process.argv[2];

if (!targetUsername) {
  console.log('现有用户:');
  for (const u of users) {
    console.log(`  ${u.username} (${u.role})`);
  }
  console.log(`\n用法: node tools/reset-password.js <用户名> [新密码]`);
  process.exit(0);
}

const user = users.find(u => u.username === targetUsername);
if (!user) {
  console.error(`用户 "${targetUsername}" 不存在。现有用户:`);
  for (const u of users) console.error(`  ${u.username}`);
  process.exit(1);
}

const newPassword = process.argv[3] || 'admin123';

const bcrypt = (await import('bcryptjs')).default;
const hash = bcrypt.hashSync(newPassword, 10);
db.prepare('UPDATE users SET passwordHash = ? WHERE id = ?').run(hash, user.id);

console.log(`用户 "${targetUsername}" 密码已重置为: ${newPassword}`);
db.close();
