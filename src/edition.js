import {readFileSync} from 'node:fs';
const metadata=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
export const runtimeEdition=metadata.edition==='user'?'user':'developer';
