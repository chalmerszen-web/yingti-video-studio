import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const [directory, version] = process.argv.slice(2);
if (!directory || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid user payload metadata');
for (const name of ['package.json', 'package-lock.json']) {
  const file=path.join(directory,name), value=JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,''));
  value.version=version;
  if(name==='package.json') {value.description='映替用户版：视频分析、内容编辑与视频生成';value.edition='user';}
  if(value.packages?.['']) value.packages[''].version=version;
  await writeFile(file,JSON.stringify(value,null,2)+'\n','utf8');
}
