export async function installFundingUI({csrf,onError}){
 const boot=await (await fetch('/api/bootstrap')).json();if(boot.edition!=='developer'||!boot.features?.fundingPreflight)return;
 const host=document.querySelector('#key-dialog .dialog-body')||document.querySelector('#key-dialog');if(!host)return;
 const box=document.createElement('section');box.className='funding-panel';
 box.innerHTML='<h3>生成额度检查</h3><button type="button" class="secondary" data-funding-check>查询账户额度</button><p role="status" data-funding-status>生成前会检查账户和密钥的可用额度。</p><p>平台暂未开放价格接口时，请填写这枚 KEY 的实际单价。配置只关联当前密钥。</p><label>币种<select data-funding-currency><option>CNY</option><option>USD</option></select></label><label>480P 每秒单价<input data-funding-480 type="number" min="0" step="any"></label><label>720P 每秒单价<input data-funding-720 type="number" min="0" step="any"></label><label>独立配音每千字单价（可选）<input data-funding-speech type="number" min="0" step="any"></label><label>单价有效至<input data-funding-date type="date"></label><button type="button" class="secondary" data-funding-save>保存已核对的单价</button>';
 host.append(box);const q=s=>box.querySelector(s),status=q('[data-funding-status]');q('[data-funding-date]').value=new Date(Date.now()+7*86400000).toISOString().slice(0,10);
 q('[data-funding-check]').onclick=async()=>{try{const r=await fetch('/api/funding'),data=await r.json();if(!r.ok)throw new Error(data.error);status.textContent=`当前可用：${data.balance.available.toFixed(4)} ${data.balance.currency}。${data.profile?'计费配置已就绪。':'请先核对并保存实际单价。'}`;if(data.profile){q('[data-funding-currency]').value=data.profile.currency;q('[data-funding-480]').value=data.profile.videoPerSecond['wan3.0-480p'];q('[data-funding-720]').value=data.profile.videoPerSecond['wan3.0-720p'];q('[data-funding-speech]').value=data.profile.speechPer1000Characters??'';q('[data-funding-date]').value=data.profile.validUntil.slice(0,10);}}catch(e){status.textContent=e.message;onError(e.message);}};
 q('[data-funding-save]').onclick=async()=>{try{
   const low=q('[data-funding-480]').value,high=q('[data-funding-720]').value,date=q('[data-funding-date]').value;
   if(!low.trim()||!high.trim()||!date)throw new Error('请填写两种画质的实际单价和有效日期。');
   const speech=q('[data-funding-speech]').value,body={currency:q('[data-funding-currency]').value,videoPerSecond:{'wan3.0-480p':Number(low),'wan3.0-720p':Number(high)},speechPer1000Characters:speech.trim()?Number(speech):null,validUntil:new Date(date+'T23:59:59').toISOString()};
   const r=await fetch('/api/funding/profile',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf()},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw new Error(data.error);status.textContent='计费配置已保存。生成时会重新读取余额并核对全部待生成内容。';
 }catch(e){status.textContent=e.message;onError(e.message);}};
}
