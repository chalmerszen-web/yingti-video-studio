export function reconstructionRequestSeconds(start,end,staged=false){
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0)return null;
  const frames=Math.round(end*30)-Math.round(start*30);
  if(frames<(staged?135:60)||frames>450)return null;
  if(!staged)return Math.max(2,Math.ceil(frames/30));
  const base=Math.floor(frames/3),remaining=frames%3;
  return [0,1,2].reduce((total,index)=>total+Math.max(2,Math.ceil((base+(index<remaining?1:0))/30)),0);
}
