import path from 'node:path';
import {readFile} from 'node:fs/promises';
const root=path.resolve(import.meta.dirname,'..');
const json=async f=>JSON.parse((await readFile(path.join(root,f),'utf8')).replace(/^\uFEFF/,''));
const developer=(await json('package.json')).version,user=await json('packaging/user-edition.json');
if(user.functionalBaseline!==developer)throw new Error('User/developer baseline mismatch');
for(const [file,labels] of [
 ['public/studio.html',[`v${developer}`,`新流程 <b>${developer}</b>`,`视频创作工作台 ${developer}`]],
 ['public/user.html',[`用户版 · ${user.version}`]],
 ['public/user-quick.html',[`用户版 · ${user.version}`]],
]){const text=await readFile(path.join(root,file),'utf8');for(const label of labels)if(!text.includes(label))throw new Error(`Update visible edition/version before packaging: ${file} -> ${label}`);}
console.log(JSON.stringify({visibleVersionsVerified:true,developer,user:user.version}));
