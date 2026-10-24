import path from 'node:path';
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {AppError,invariant} from './errors.js';
import {narrationRequest} from './narration.js';

const unsupported=()=>new AppError('暂时无法核对生成所需额度，请检查计费配置后重试。尚未提交生成。',503,'funding_unavailable');
export function validateFundingProfile(value,keyHash){
  invariant(value&&['CNY','USD'].includes(value.currency)&&value.videoPerSecond&&typeof keyHash==='string','请填写平台实际计费币种和单价。');
  const prices={};for(const model of ['wan3.0-480p','wan3.0-720p']){
    const rate=value.videoPerSecond[model];invariant(typeof rate==='number'&&Number.isFinite(rate)&&rate>=0&&rate<=10000,'视频每秒单价须为有效非负数。');prices[model]=rate;
  }
  const speech=value.speechPer1000Characters;
  invariant(speech==null||typeof speech==='number'&&Number.isFinite(speech)&&speech>=0&&speech<=10000,'配音每千字单价无效。');
  const validUntil=Date.parse(value.validUntil);invariant(Number.isFinite(validUntil)&&validUntil>Date.now(),'请确认单价的有效截止日期。');
  return {version:1,keyHash,currency:value.currency,videoPerSecond:prices,speechPer1000Characters:speech??null,validUntil:new Date(validUntil).toISOString(),confirmedAt:new Date().toISOString()};
}

export function pendingGenerationCost(job,profile,{includeSpeech=false}={}){
  const pending=job.segments.filter(p=>!p.taskId&&p.state!=='completed'&&p.generationMode!=='base_copy');
  if(!pending.length&&!includeSpeech)return {amount:0,currency:profile?.currency,requestedSeconds:0,speechCharacters:0};
  if(!profile||!['CNY','USD'].includes(profile.currency))throw unsupported();
  const rate=profile.videoPerSecond?.[job.model];if(pending.length&&(!Number.isFinite(rate)||rate<0))throw unsupported();
  const seconds=pending.reduce((sum,p)=>{invariant(Number.isInteger(p.requestDuration)&&p.requestDuration>=2&&p.requestDuration<=15,'生成计费时长无效。');return sum+p.requestDuration;},0);
  let speechCharacters=0,amount=seconds*(rate||0);
  if(includeSpeech){const request=narrationRequest(job);if(request){if(!Number.isFinite(profile.speechPer1000Characters)||profile.speechPer1000Characters<0)throw unsupported();speechCharacters=[...request.input].length;amount+=speechCharacters/1000*profile.speechPer1000Characters;}}
  // Round estimates upward to a millionth of the configured currency.
  return {amount:Math.ceil((amount-Number.EPSILON)*1e6)/1e6,currency:profile.currency,requestedSeconds:seconds,speechCharacters};
}

export class FundingGate {
  constructor({directory,profileLoader,now=Date.now}){this.directory=directory;this.profileLoader=profileLoader;this.now=now;}
  async profile(keyHash){
    let value;
    try{value=this.profileLoader?await this.profileLoader(keyHash):JSON.parse(await readFile(path.join(this.directory,'funding-profile.json'),'utf8'));}catch{throw unsupported();}
    if(value?.keyHash!==keyHash||Date.parse(value.validUntil)<=this.now()||!Number.isFinite(Date.parse(value.validUntil)))throw unsupported();return value;
  }
  async save(value,keyHash){
    const profile=validateFundingProfile(value,keyHash);await mkdir(this.directory,{recursive:true});const file=path.join(this.directory,'funding-profile.json');await writeFile(file+'.tmp',JSON.stringify(profile,null,2),'utf8');await rename(file+'.tmp',file);return profile;
  }
  async ensure(job,provider,{includeSpeech=false,signal}={}){
    const needed=includeSpeech||job.segments.some(p=>!p.taskId&&p.state!=='completed'&&p.generationMode!=='base_copy');if(!needed)return {state:'not_required'};
    const profile=await this.profile(job.keyHash),quote=pendingGenerationCost(job,profile,{includeSpeech});
    if(typeof provider.balance!=='function')throw unsupported();const balance=await provider.balance({signal});
    if(!Number.isFinite(balance.available)||balance.available<0)throw unsupported();
    if(balance.modelLimitsEnabled&&!balance.modelLimits?.[job.model])throw new AppError('当前访问密钥未开通所选视频服务，尚未提交生成。',409,'funding_permission');
    let amount=quote.amount;
    if(balance.currency!==quote.currency){
      if(!Number.isFinite(balance.usdExchangeRate)||balance.usdExchangeRate<=0)throw unsupported();
      if(balance.currency==='CNY'&&quote.currency==='USD')amount*=balance.usdExchangeRate;
      else if(balance.currency==='USD'&&quote.currency==='CNY')amount/=balance.usdExchangeRate;
      else if(balance.currency==='TOKENS'&&Number.isFinite(balance.quotaPerUnit)&&balance.quotaPerUnit>0)amount=amount/(quote.currency==='CNY'?balance.usdExchangeRate:1)*balance.quotaPerUnit;
      else throw unsupported();
    }
    if(balance.available+1e-10<amount)throw new AppError('余额不足，尚未提交新的生成。请补充额度后继续，已完成内容会保留。',402,'insufficient_funds');
    // Never return or persist monetary values in the user-facing job/receipt.
    return {state:'approved',checkedAt:balance.checkedAt||new Date(this.now()).toISOString(),requestedSeconds:quote.requestedSeconds};
  }
}
