import { readFile, writeFile, mkdir, symlink, lstat, readlink, copyFile, cp, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), value = (flag) => args[args.indexOf(flag) + 1];
if (!args.includes('--runtime-root')) throw new Error('请通过 --runtime-root 指定当前 DSH 的 node_modules 目录。');
const runtime = resolve(value('--runtime-root'));
const installed = JSON.parse(await readFile(join(runtime, '@deepseek-ai/dsh/package.json'), 'utf8'));
if (installed.version !== '0.1.5-rc.1') throw new Error(`当前版本 ${installed.version} 尚未验收；需要 DSH 0.1.5-rc.1。`);
async function link(target, destination, replaceTarget) {
  await mkdir(dirname(destination), { recursive: true });
  const stat = await lstat(destination).catch((e) => { if (e.code !== 'ENOENT') throw e; });
  if (stat) {
    const current = stat.isSymbolicLink() ? resolve(dirname(destination), await readlink(destination)) : null;
    if (current === target) return;
    if (current !== replaceTarget) throw new Error(`已有其他安装，未覆盖：${destination}`);
    await unlink(destination);
  }
  await symlink(target, destination, 'dir');
}
// Runtime SDK linking belongs to the installed copy. Development dependencies
// are installed from the lockfile and are not replaced by this installer.
const contract = resolve(root, '../../packages/host-contract');
const contractManifest = JSON.parse(await readFile(join(contract, 'package.json'), 'utf8'));
if (contractManifest.version !== '1.0.0') throw new Error('需要 host-contract 1.0.0。');
if (!args.includes('--link-only')) {
  const installRoot = join(homedir(), '.local/share/paper-radar/dsh-plugin');
  await mkdir(installRoot, { recursive: true, mode: 0o700 });
  await cp(join(root, 'src'), join(installRoot, 'src'), { recursive: true });
  await cp(contract, join(installRoot, 'node_modules/@paper-radar/host-contract'), { recursive: true });
  for (const file of ['package.json', 'README.md', 'COMPATIBILITY.md']) {
    await copyFile(join(root, file), join(installRoot, file)).catch((e) => { if (e.code !== 'ENOENT') throw e; });
  }
  await link(join(runtime, '@deepseek-ai/dsh-llm'), join(installRoot, 'node_modules/@deepseek-ai/dsh-llm'));
  const profile = join(homedir(), '.dsh/profiles', args.includes('--profile') ? value('--profile') : 'web');
  const manifestPath = join(profile, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const patchPath = join(profile, 'cordis.patch.yml');
  const original = await readFile(patchPath, 'utf8');
  const start = '# PaperRadar plugin begin', end = '# PaperRadar plugin end';
  const stanza = `${start}\n- insert:\n    - id: paper-radar\n      name: paper-radar-dsh-plugin\n      inject: [webServer]\n      config:\n        paperRadarUrl: http://127.0.0.1:4317\n        dshUrl: http://127.0.0.1:3080\n${end}\n`;
  if (/id:\s*paper-radar\s*$/m.test(original) && !original.includes(start)) throw new Error('配置中已有 PaperRadar 条目，请先核对现有安装。');
  const updated = original.includes(start) ? original.slice(0, original.indexOf(start)) + stanza + original.slice(original.indexOf(end) + end.length).replace(/^\n/, '') : original.replace(/^\[\]\s*$/m, '') + '\n' + stanza;
  await link(installRoot, join(profile, 'node_modules/paper-radar-dsh-plugin'), root);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await copyFile(manifestPath, `${manifestPath}.paper-radar-${stamp}.bak`);
  await copyFile(patchPath, `${patchPath}.paper-radar-${stamp}.bak`);
  manifest.dependencies = { ...manifest.dependencies, 'paper-radar-dsh-plugin': `link:${installRoot}` };
  delete manifest.dependencies['paper-radar-harness-plugin'];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(patchPath, updated);
  console.log('PaperRadar 插件已加入 DSH；原配置已备份。业务服务切换需先验证宿主连接。');
} else console.log('宿主版本与共享契约已检查，未修改 DSH 配置；开发依赖由 npm ci 安装。');
