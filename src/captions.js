import { speechWeight } from './full-dialogue.js';
import { invariant } from './errors.js';

export function captionChunks(text, max = 16) {
  const out = []; let chunk = '';
  for (const char of text.replace(/\s+/gu, '')) {
    chunk += char;
    if ([...chunk].length >= max || /[。！？!?；;]/u.test(char)) { out.push(chunk); chunk = ''; }
  }
  if (chunk) out.push(chunk);
  const chunks=[];
  for(const text of out) {
    if(/[\p{L}\p{N}]/u.test(text))chunks.push(text);
    else if(chunks.length)chunks[chunks.length-1]+=text;
  }
  return chunks;
}
export function captionEvents(job) {
  const full = job.recipe?.edits?.fullDialogue;
  if (!full?.enabled || full.subtitles !== 'replace') return [];
  const narration = job.audioMode === 'narration';
  const lines = narration ? [{ start: 0, end: job.narration?.duration, text: job.recipe.dialoguePlan.spokenText }] : job.recipe.dialoguePlan?.lines || [];
  const events = [];
  for (const line of lines) {
    invariant(Number.isFinite(line.start) && Number.isFinite(line.end) && line.end > line.start, '字幕缺少有效的新声音时间，未使用原稿补字幕。');
    const chunks = captionChunks(line.text), weights = chunks.map(text => Math.max(1, speechWeight(text))), total = weights.reduce((a,b)=>a+b,0);
    let used = 0;
    chunks.forEach((text,index) => {
      const start = line.start + (line.end - line.start) * used / total;
      used += weights[index];
      events.push({ start, end: line.start + (line.end - line.start) * used / total, text });
    });
  }
  return events;
}
const assTime = n => { const centiseconds=Math.round(n*100); return `${Math.floor(centiseconds/360000)}:${String(Math.floor(centiseconds/6000)%60).padStart(2,'0')}:${String(Math.floor(centiseconds/100)%60).padStart(2,'0')}.${String(centiseconds%100).padStart(2,'0')}`; };
const escapeAss = text => text.replace(/\\/g,'\\u005c').replace(/\{/g,'\\u007b').replace(/\}/g,'\\u007d').replace(/[\r\n]/g,' ');
export function captionASS(events, width, height) {
  const size = Math.max(18, Math.round(width * 0.047));
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 0\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Microsoft YaHei,${size},&H00FFFFFF,&H00FFFFFF,&H00202020,&H66000000,1,0,0,0,100,100,0,0,1,${Math.max(1,size/14).toFixed(1)},0,2,24,24,${Math.round(height*0.17)},1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events.map(e=>`Dialogue: 0,${assTime(e.start)},${assTime(e.end)},Default,,0,0,0,,${escapeAss(e.text)}`).join('\n')}\n`;
}
