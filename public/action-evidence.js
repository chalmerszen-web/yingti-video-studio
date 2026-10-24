// Shared by the editor and the frozen generation recipe. Text cues flag an
// inconsistent observation; they never invent a movement from product copy.
export const actionModes = ['auto', 'on', 'off', 'spread', 'spread_finish'];
const value = text => typeof text === 'string' ? text.trim() : '';
const ambiguous = /看不清|无法(?:确认|判断|看清)|不能确认|尚不确定|是否.+不确定|(?:没有|未见|未看到|未能看到).{0,8}(?:接触|推开|抹开|揉匀|涂抹)/u;
const existing = /(?:已有|有|呈|留有|存在|残留).{0,20}(?:膏|乳霜|液体|白点|条纹)|(?:膏|乳霜).{0,15}(?:在|点|条纹|块|覆盖)/u;
const spreading = /推开|抹开|摊开|铺展|揉匀|涂开|抚平|打圈|涂抹/u;
const contact = /手指|指腹|指尖|手掌|手部|接触|掌心/u;
export function actionEvidence(action) {
  const complete = !!action && Number.isFinite(action.start) && Number.isFinite(action.end) && action.end > action.start
    && !!action.characterId && ['region', 'before', 'after', 'evidence'].every(field => value(action[field]));
  const evidence = `${value(action?.contact)} ${value(action?.evidence)}`;
  const uncertain = ambiguous.test(evidence);
  const spreadEvidence = complete && !uncertain && contact.test(evidence) && spreading.test(evidence)
    && (existing.test(value(action.before)) || spreading.test(value(action.after)));
  const conflict = action?.type === 'apply' && spreadEvidence && existing.test(value(action.before));
  const grounded = action?.type === 'spread' ? spreadEvidence
    : action?.type === 'apply' ? contact.test(evidence) && /点涂|点上|附着|沾|新增|挤|涂/u.test(evidence)
      : action?.type === 'residue' ? /膏|乳霜|液体|残留|薄层|条纹/u.test(evidence) : false;
  return {
    complete,
    uncertain,
    conflict,
    canSpread: !!spreadEvidence && ['apply', 'spread'].includes(action?.type),
    grounded,
    reviewReason: conflict ? '记录标为点涂，但画面证据描述推开已有膏体。请查看原片确认动作。'
      : uncertain ? '接触或膏体变化的证据不明确，暂不添加硬性涂抹要求。'
        : !complete ? '人物、部位或起止状态尚不完整，暂不添加硬性涂抹要求。'
          : !grounded && ['apply', 'spread', 'residue'].includes(action?.type) ? '记录没有明确接触或可见材料证据，请先核对原片。' : '',
  };
}
export function effectiveAction(action, mode = 'auto') {
  const observation = actionEvidence(action);
  if (!observation.complete || observation.uncertain || !['apply', 'spread', 'residue'].includes(action.type) || mode === 'off') return null;
  if (['spread', 'spread_finish'].includes(mode)) {
    if (!observation.canSpread) return null;
    return { ...action, sourceType: action.type, type: 'spread', reviewed: true, target: mode === 'spread_finish' ? 'spread_finish' : 'source' };
  }
  if (!observation.grounded) return null;
  if (observation.conflict || !['auto', 'on'].includes(mode) || action.confidence !== 'high' && mode !== 'on') return null;
  return { ...action, sourceType: action.type, target: 'source', reviewed: mode === 'on' };
}
