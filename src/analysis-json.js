import { AppError, invariant } from './errors.js';

const textFields = new Set(['summary', 'name', 'description', 'camera', 'text', 'emotion', 'region', 'before', 'after', 'evidence', 'detail']);
const location = (source, offset) => {
  const before = source.slice(0, offset), lines = before.split('\n');
  return { offset, line: lines.length, column: lines.at(-1).length + 1 };
};
const pointer = parts => '/' + parts.map(p => String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');

// Deliberately narrow recovery: punctuation only, never guess missing content,
// numeric timings, IDs, fields, closing containers, or incomplete responses.
function repairSyntax(source, baseOffset, original) {
  let i = 0;
  const edits = [];
  const whitespace = () => { while (/[\t\n\r ]/.test(source[i] || '\0')) i++; };
  const fail = reason => { const error = new Error(reason); error.position = i; throw error; };
  const edit = (start, end, replacement, kind, path) => {
    if (edits.length >= 8) fail('too_many_repairs');
    edits.push({ start, end, replacement, kind, path: pointer(path), ...location(original, baseOffset + start) });
  };
  const readString = path => {
    if (source[i++] !== '"') fail('expected_string');
    let encoded = '"';
    while (i < source.length) {
      const c = source[i++];
      if (c === '"') { try { return JSON.parse(encoded + '"'); } catch { fail('invalid_string'); } }
      if (c === '\\') {
        const next = source[i++];
        if (next === 'u') {
          if (!/^[a-f\d]{4}$/i.test(source.slice(i, i + 4))) fail('invalid_escape');
          encoded += '\\u' + source.slice(i, i + 4); i += 4;
        } else {
          if (!next || !'"\\/bfnrt'.includes(next)) fail('invalid_escape');
          encoded += '\\' + next;
        }
      } else if (c.charCodeAt(0) < 32) {
        if (!['\n', '\r', '\t'].includes(c) || !textFields.has(path.at(-1))) fail('invalid_control');
        const escaped = JSON.stringify(c).slice(1, -1);
        edit(i - 1, i, escaped, 'escaped_control_character', path); encoded += escaped;
      } else encoded += c;
    }
    fail('unterminated_string');
  };
  const bareText = path => {
    if (!textFields.has(path.at(-1)) || ['{', '[', '}', ']', ',', ':'].includes(source[i])) return false;
    const start = i;
    for (let end = start; end < source.length && !/[\r\n]/.test(source[end]); end++) {
      const c = source[end];
      if ('{}[]'.includes(c)) return false;
      if (c === '\\') { end++; continue; }
      if (c !== '"') continue;
      // The first unescaped quote must close this value. Never consume another key.
      if (!/^"\s*[,}\]]/.test(source.slice(end)) || end === start) return false;
      try { JSON.parse('"' + source.slice(start, end + 1)); } catch { return false; }
      edit(start, start, '"', 'missing_opening_quote', path); i = end + 1; return true;
    }
    return false;
  };
  const value = (path, depth = 0) => {
    if (depth > 64) fail('too_deep');
    whitespace();
    if (source[i] === '"') { readString(path); return; }
    if (source[i] === '{') {
      i++; whitespace(); const keys = new Set();
      if (source[i] === '}') { i++; return; }
      for (;;) {
        whitespace(); const key = readString([]);
        if (key.length > 512 || keys.has(key)) fail('ambiguous_key'); keys.add(key);
        whitespace(); if (source[i++] !== ':') fail('expected_colon');
        value([...path, key], depth + 1); whitespace();
        if (source[i] === '}') { i++; return; }
        if (source[i] !== ',') fail('expected_object_end');
        const comma = i++; whitespace();
        if (source[i] === '}') { edit(comma, comma + 1, '', 'trailing_comma', path); i++; return; }
      }
    }
    if (source[i] === '[') {
      i++; whitespace(); let index = 0;
      if (source[i] === ']') { i++; return; }
      for (;;) {
        value([...path, index++], depth + 1); whitespace();
        if (source[i] === ']') { i++; return; }
        if (source[i] !== ',') fail('expected_array_end');
        const comma = i++; whitespace();
        if (source[i] === ']') { edit(comma, comma + 1, '', 'trailing_comma', path); i++; return; }
      }
    }
    if (bareText(path)) return;
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=[\s,}\]]|$)/.exec(source.slice(i));
    if (!token) fail('invalid_value');
    i += token[0].length;
  };
  try {
    value([]); whitespace();
    if (i !== source.length) fail('unexpected_suffix');
    if (!edits.length) fail('not_repairable');
    let normalized = source;
    for (const patch of [...edits].sort((a, b) => b.start - a.start)) normalized = normalized.slice(0, patch.start) + patch.replacement + normalized.slice(patch.end);
    return { value: JSON.parse(normalized), corrections: edits.map(({ start, end, replacement, ...audit }) => audit) };
  } catch (error) {
    const at = location(original, baseOffset + Math.min(source.length, error.position ?? i));
    const result = new AppError(`Omni-Analysis 已返回完整文本，但第 ${at.line} 行附近的 JSON 格式无法安全修复；原始结果已保存。`, 422, 'analysis_json');
    result.details = { ...at, reason: error.message, attemptedCorrections: edits.length, appliedCorrections: 0 };
    throw result;
  }
}

export function parseAnalysisJSON(raw) {
  invariant(typeof raw === 'string' && raw.length <= 1000000, '分析正文无效。');
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return { value: JSON.parse(trimmed), corrections: [] }; } catch {}
  const begin = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (begin < 0 || end <= begin) {
    const error = new AppError('Omni-Analysis 已返回文本，但没有完整的资产和分镜 JSON；原始结果已保存。', 422, 'analysis_json');
    error.details = { reason: 'missing_object', appliedCorrections: 0 }; throw error;
  }
  const candidate = raw.slice(begin, end + 1);
  try { return { value: JSON.parse(candidate), corrections: [] }; } catch {}
  return repairSyntax(candidate, begin, raw);
}
