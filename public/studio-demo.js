export function demoProject() {
  return {
    id: 'demo', title: '清晨的护肤时刻 · 交互示例', sourceName: '示例视频', state: 'ready', phase: '示例', revision: 0, source: { duration: 24, width: 1280, height: 720, hasAudio: true },
    created: '2026-10-06T00:00:00+08:00', updated: '2026-10-06T00:00:00+08:00', keyMatches: true, analysis: { windows: [] },
    story: {
      summary: '清晨，林夏在客厅整理护肤用品，向陈言介绍新收到的精华。两人围绕使用感受交谈，最后以桌面的产品特写结束。\n这是用于展示编辑流程的示例数据，没有分析任何用户视频。',
      assets: [
        { id: 'C001', type: 'character', name: '林夏 · 白衣女人', description: '短发，米白色上衣，位于画面左侧。手持白色精华瓶，语气自然温柔。', firstSeen: 0, confidence: 'high' },
        { id: 'C002', type: 'character', name: '陈言 · 绿衣男人', description: '短发，浅绿色衬衫，位于画面右侧。面向林夏回应，声音平稳。', firstSeen: 3, confidence: 'high' },
        { id: 'S001', type: 'scene', name: '晨光客厅', description: '米色墙面，右侧窗户透入自然光，浅木桌与绿植构成背景。', firstSeen: 0, confidence: 'high' },
        { id: 'P001', type: 'prop', name: '白色精华瓶', description: '白色圆柱瓶身，浅绿色瓶盖与标签。林夏拿在右手中，结尾放在桌上。', firstSeen: 0, confidence: 'high' },
        { id: 'P002', type: 'prop', name: '玻璃水杯', description: '透明直身水杯，位于木桌右侧，陈言伸手拿起。', firstSeen: 9, confidence: 'medium' },
      ],
      shots: [
        { id: 'SH001', start: 0, end: 6, summary: '林夏从桌上拿起精华瓶，转向右侧的陈言说话。', camera: '中景，缓慢推进', characterIds: ['C001', 'C002'], sceneId: 'S001', propIds: ['P001'] },
        { id: 'SH002', start: 6, end: 12, summary: '陈言看向瓶子，微笑回应；右手拿起桌上的水杯。', camera: '过肩反打，固定镜头', characterIds: ['C001', 'C002'], sceneId: 'S001', propIds: ['P001', 'P002'] },
        { id: 'SH003', start: 12, end: 18, summary: '林夏将精华倒在手背，展示质地，然后看向陈言。', camera: '手部近景，切人物近景', characterIds: ['C001', 'C002'], sceneId: 'S001', propIds: ['P001'] },
        { id: 'SH004', start: 18, end: 24, summary: '两人笑着结束交谈，精华瓶放回桌面，镜头停留在产品上。', camera: '双人中景转产品特写', characterIds: ['C001', 'C002'], sceneId: 'S001', propIds: ['P001', 'P002'] },
      ],
      dialogues: [
        { id: 'L001', start: 1.2, end: 4.8, characterId: 'C001', text: '这是我最近新换的精华，你看看。', emotion: '轻松分享', uncertain: false },
        { id: 'L002', start: 7, end: 9.8, characterId: 'C002', text: '包装挺简洁的，用起来怎么样？', emotion: '好奇', uncertain: false },
        { id: 'L003', start: 13.1, end: 16.7, characterId: 'C001', text: '质地很轻，早上用起来很方便。', emotion: '自然', uncertain: false },
        { id: 'L004', start: 19.2, end: 21.5, characterId: 'C002', text: '听起来不错，我也试试看。', emotion: '微笑', uncertain: true },
      ], warnings: [],
    }, edits: { model: 'wan3.0-720p', assets: {}, dialogues: [] },
  };
}
